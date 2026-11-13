// Page-world bridge script injected at document_start on x.com (world: "MAIN").
// Passively harvests X's own relationship state (whether the signed-in user follows
// each post's author, plus promotedMetadata and socialContext flags) from X's
// GraphQL responses, Redux entity store, and React Fiber props, then stamps inert
// data-fo-* metadata attributes onto article[data-testid="tweet"] elements.

(() => {
  if (globalThis.__friendsOnlyBridgeInstalled) return;
  globalThis.__friendsOnlyBridgeInstalled = true;

  const RESERVED_PATHS = new Set([
    "home",
    "explore",
    "notifications",
    "messages",
    "i",
    "settings",
    "compose",
    "search",
    "hashtag",
    "tos",
    "privacy",
    "jobs",
    "lists",
    "bookmarks",
    "communities"
  ]);

  const SUGGESTED_CONTEXT_TYPES = new Set([
    "follow",
    "like",
    "popular",
    "topic",
    "community",
    "recommendation",
    "moment",
    "trending",
    "newuser"
  ]);

  const followingByHandle = new Map();
  const followingByUserId = new Map();
  const handleByUserId = new Map();
  const tweetMetaById = new Map();
  const selfUserIds = new Set();
  const selfHandles = new Set();

  let annotateScheduled = false;
  let cachedReduxStore = null;

  function normalizeHandle(raw) {
    if (typeof raw !== "string") return null;
    const cleaned = raw.trim().replace(/^@/, "").toLowerCase();
    if (!cleaned || RESERVED_PATHS.has(cleaned) || !/^[a-z0-9_]{1,30}$/i.test(cleaned)) {
      return null;
    }
    return cleaned;
  }

  function detectSelfFromCookiesAndNav() {
    try {
      const match = document.cookie.match(/(?:^|;\s*)twid=([^;]+)/);
      if (match) {
        const decoded = decodeURIComponent(match[1]).replace(/^"|"$/g, "");
        const idMatch = decoded.match(/u=(\d+)/);
        if (idMatch) {
          selfUserIds.add(idMatch[1]);
        }
      }
    } catch {
      // Ignore cookie access errors.
    }

    const profileLink = document.querySelector('a[data-testid="AppTabBar_Profile_Link"][href]');
    if (profileLink) {
      const handle = extractHandleFromHref(profileLink.getAttribute("href"));
      if (handle) {
        selfHandles.add(handle);
        followingByHandle.set(handle, true);
      }
    }
  }

  function extractHandleFromHref(href) {
    if (!href || typeof href !== "string") return null;
    try {
      const url = new URL(href, window.location.origin);
      const firstSegment = url.pathname.split("/").filter(Boolean)[0];
      return normalizeHandle(firstSegment);
    } catch {
      return null;
    }
  }

  function recordUserRelationship(userId, rawHandle, following, friendshipOverride) {
    const handle = normalizeHandle(rawHandle);
    const id = userId ? String(userId) : null;
    const isSelf = Boolean((id && selfUserIds.has(id)) || (handle && selfHandles.has(handle)));

    if (isSelf) {
      if (id) selfUserIds.add(id);
      if (handle) selfHandles.add(handle);
    }

    let resolvedFollowing = isSelf ? true : friendshipOverride;
    if (typeof resolvedFollowing !== "boolean" && typeof following === "boolean") {
      resolvedFollowing = following;
    }

    if (id && handle) {
      handleByUserId.set(id, handle);
    }

    if (typeof resolvedFollowing === "boolean") {
      if (handle) {
        followingByHandle.set(handle, resolvedFollowing);
      }
      if (id) {
        followingByUserId.set(id, resolvedFollowing);
      }
    }
  }

  function extractFollowingFromUserObject(obj) {
    if (!obj || typeof obj !== "object") return undefined;

    if (
      obj.relationship_perspectives?.super_following === true ||
      obj.legacy?.super_following === true ||
      obj.super_following === true
    ) {
      return true;
    }

    if (typeof obj.relationship_perspectives?.following === "boolean") {
      return obj.relationship_perspectives.following;
    }

    if (typeof obj.legacy?.following === "boolean") {
      return obj.legacy.following;
    }

    if (typeof obj.following === "boolean") {
      return obj.following;
    }

    return undefined;
  }

  function unwrapTweetResult(raw) {
    if (!raw || typeof raw !== "object") return null;
    if (raw.__typename === "TweetWithVisibilityResults" && raw.tweet) {
      return raw.tweet;
    }
    return raw;
  }

  function harvestUserNode(obj, friendshipOverride) {
    if (!obj || typeof obj !== "object") return null;
    const unwrapped = obj.result && typeof obj.result === "object" ? obj.result : obj;

    const userId = unwrapped.rest_id ?? unwrapped.id_str ?? unwrapped.id;
    const rawHandle =
      unwrapped.core?.screen_name ?? unwrapped.legacy?.screen_name ?? unwrapped.screen_name;
    const following = extractFollowingFromUserObject(unwrapped);

    if (rawHandle || (userId && typeof following === "boolean")) {
      recordUserRelationship(userId, rawHandle, following, friendshipOverride);
    }

    return {
      userId: userId ? String(userId) : null,
      handle: normalizeHandle(rawHandle),
      following:
        typeof friendshipOverride === "boolean"
          ? friendshipOverride
          : (userId && selfUserIds.has(String(userId))) ||
              (rawHandle && selfHandles.has(normalizeHandle(rawHandle)))
            ? true
            : following
    };
  }

  function upsertTweetMeta(tweetId, patch) {
    if (!tweetId) return;
    const key = String(tweetId);
    const prev = tweetMetaById.get(key) || {};
    tweetMetaById.set(key, {
      authorHandle: patch.authorHandle ?? prev.authorHandle,
      following: typeof patch.following === "boolean" ? patch.following : prev.following,
      promoted: Boolean(prev.promoted || patch.promoted),
      suggested: Boolean(prev.suggested || patch.suggested)
    });
  }

  function classifySocialContext(socialContext) {
    if (!socialContext || typeof socialContext !== "object") {
      return { promoted: false, suggested: false };
    }

    const typeName = String(socialContext.type || "").toLowerCase();
    const contextType = String(socialContext.contextType || "").toLowerCase();

    if (contextType === "sparkle") {
      return { promoted: true, suggested: false };
    }

    if (typeName.includes("topic") || SUGGESTED_CONTEXT_TYPES.has(contextType)) {
      return { promoted: false, suggested: true };
    }

    return { promoted: false, suggested: false };
  }

  function harvestTweetNode(rawTweet, itemMeta = {}) {
    const tweet = unwrapTweetResult(rawTweet);
    if (!tweet || typeof tweet !== "object") return;

    const tweetId = tweet.rest_id ?? tweet.legacy?.id_str ?? tweet.id_str;
    const authorInfo = harvestUserNode(tweet.core?.user_results ?? tweet.user);

    // If this entry is a Repost, X displays the retweeted tweet's author in User-Name.
    const retweetRaw =
      tweet.legacy?.retweeted_status_result?.result ??
      tweet.retweeted_status_result?.result ??
      tweet.retweeted_status;
    if (retweetRaw) {
      harvestTweetNode(retweetRaw, { promoted: itemMeta.promoted });
    }

    const displayTweet = retweetRaw ? unwrapTweetResult(retweetRaw) : tweet;
    const displayAuthor = retweetRaw
      ? harvestUserNode(displayTweet?.core?.user_results ?? displayTweet?.user)
      : authorInfo;

    const promoted = Boolean(
      itemMeta.promoted || tweet.promotedMetadata || tweet.adMetadataContainer
    );
    const contextFlags = classifySocialContext(itemMeta.socialContext || tweet.socialContext);

    const resolvedFollowing =
      typeof displayAuthor?.following === "boolean"
        ? displayAuthor.following
        : displayAuthor?.handle
          ? followingByHandle.get(displayAuthor.handle)
          : undefined;

    if (tweetId) {
      upsertTweetMeta(tweetId, {
        authorHandle: displayAuthor?.handle,
        following: resolvedFollowing,
        promoted: promoted || contextFlags.promoted,
        suggested: contextFlags.suggested && resolvedFollowing !== true
      });
    }
  }

  function harvestPayload(root, friendshipOverride) {
    if (!root || typeof root !== "object") return;
    detectSelfFromCookiesAndNav();

    const visited = new WeakSet();
    const stack = [{ node: root, depth: 0 }];

    while (stack.length > 0) {
      const { node, depth } = stack.pop();
      if (!node || typeof node !== "object" || depth > 50 || visited.has(node)) {
        continue;
      }
      visited.add(node);

      if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i += 1) {
          stack.push({ node: node[i], depth: depth + 1 });
        }
        continue;
      }

      if (
        node.__typename === "User" ||
        ((node.rest_id || node.id_str) &&
          (node.relationship_perspectives || node.core?.screen_name || node.legacy?.screen_name)) ||
        (typeof node.screen_name === "string" && typeof node.following === "boolean")
      ) {
        harvestUserNode(node, friendshipOverride);
      }

      const itemContent = node.itemContent || node.content?.itemContent || node.item?.itemContent;
      if (itemContent && typeof itemContent === "object") {
        const promoted = Boolean(itemContent.promotedMetadata || node.promotedMetadata);
        const socialContext = itemContent.socialContext || node.socialContext;
        if (itemContent.tweet_results?.result) {
          harvestTweetNode(itemContent.tweet_results.result, { promoted, socialContext });
        }
      }

      if (node.__typename === "Tweet" || node.__typename === "TweetWithVisibilityResults") {
        harvestTweetNode(node);
      }

      const keys = Object.keys(node);
      for (let i = 0; i < keys.length; i += 1) {
        const val = node[keys[i]];
        if (val && typeof val === "object") {
          stack.push({ node: val, depth: depth + 1 });
        }
      }
    }

    scheduleAnnotate();
  }

  function getReactFiber(el) {
    if (!el || typeof el !== "object") return null;
    const keys = Object.keys(el);
    for (let i = 0; i < keys.length; i += 1) {
      if (keys[i].startsWith("__reactFiber$") || keys[i].startsWith("__reactInternalInstance$")) {
        return el[keys[i]];
      }
    }
    return null;
  }

  function findReduxStore() {
    if (cachedReduxStore) return cachedReduxStore;
    const reactRoot = document.getElementById("react-root");
    if (!reactRoot) return null;

    const keys = Object.keys(reactRoot);
    let containerFiber = null;
    for (let i = 0; i < keys.length; i += 1) {
      if (keys[i].startsWith("__reactContainer$")) {
        containerFiber = reactRoot[keys[i]];
        break;
      }
    }
    if (!containerFiber && reactRoot._reactRootContainer?._internalRoot?.current) {
      containerFiber = reactRoot._reactRootContainer._internalRoot.current;
    }
    if (!containerFiber) return null;

    const queue = [containerFiber];
    const seen = new WeakSet();
    let visitedCount = 0;

    while (queue.length > 0 && visitedCount < 120) {
      const fiber = queue.shift();
      if (!fiber || typeof fiber !== "object" || seen.has(fiber)) continue;
      seen.add(fiber);
      visitedCount += 1;

      const store = fiber.memoizedProps?.store || fiber.stateNode?.store;
      if (store && typeof store.getState === "function") {
        cachedReduxStore = store;
        return store;
      }

      if (fiber.child) queue.push(fiber.child);
      if (fiber.sibling) queue.push(fiber.sibling);
    }

    return null;
  }

  function harvestFromReduxStoreIfAvailable() {
    const store = findReduxStore();
    if (!store) return;

    try {
      const state = store.getState();
      const sessionUserId =
        state?.session?.user_id || state?.authentication?.userId || state?.settings?.remote?.id;
      if (sessionUserId) {
        selfUserIds.add(String(sessionUserId));
      }

      const usersMap = state?.entities?.users?.entities;
      if (usersMap && typeof usersMap === "object") {
        const userIds = Object.keys(usersMap);
        for (let i = 0; i < userIds.length; i += 1) {
          const id = userIds[i];
          if (!followingByUserId.has(id)) {
            harvestUserNode(usersMap[id]);
          }
        }
      }
    } catch {
      // Ignore store inspection errors.
    }
  }

  function harvestFromArticleFiber(article) {
    let fiber = getReactFiber(article);
    let steps = 0;

    while (fiber && steps < 35) {
      const props = fiber.memoizedProps;
      if (props && typeof props === "object") {
        if (props.promotedMetadata || props.tweet?.promotedMetadata || props.item?.promotedMetadata) {
          article.setAttribute("data-fo-promoted", "true");
        }

        const candidateUser =
          props.tweet?.user ||
          props.tweet?.core?.user_results?.result ||
          props.retweetedStatus?.user ||
          props.user;
        if (candidateUser && typeof candidateUser === "object") {
          harvestUserNode(candidateUser);
        }

        if (props.tweet && typeof props.tweet === "object") {
          harvestTweetNode(props.tweet);
        }
      }
      fiber = fiber.return;
      steps += 1;
    }
  }

  function extractPrimaryAuthorAndTweetId(article) {
    const userNameBox = article.querySelector('[data-testid="User-Name"]');
    let authorHandle = null;

    if (userNameBox) {
      const links = userNameBox.querySelectorAll("a[href]");
      for (let i = 0; i < links.length; i += 1) {
        const handle = extractHandleFromHref(links[i].getAttribute("href"));
        if (handle) {
          authorHandle = handle;
          break;
        }
      }
    }

    let tweetId = null;
    const statusLinks = article.querySelectorAll('a[href*="/status/"]');
    for (let i = 0; i < statusLinks.length; i += 1) {
      const link = statusLinks[i];
      // Prefer the status link belonging to the outer tweet rather than a quoted post.
      const closestUserNameContainer = link.closest('[role="link"]');
      if (closestUserNameContainer && userNameBox && !closestUserNameContainer.contains(userNameBox)) {
        continue;
      }
      const match = link.getAttribute("href")?.match(/\/status\/(\d+)/);
      if (match) {
        tweetId = match[1];
        if (!authorHandle) {
          authorHandle = extractHandleFromHref(link.getAttribute("href"));
        }
        break;
      }
    }

    return { authorHandle, tweetId };
  }

  function setOrRemoveAttr(el, name, value) {
    if (value === null || value === undefined) {
      if (el.hasAttribute(name)) el.removeAttribute(name);
    } else if (el.getAttribute(name) !== value) {
      el.setAttribute(name, value);
    }
  }

  function annotateTweets() {
    annotateScheduled = false;
    detectSelfFromCookiesAndNav();
    harvestFromReduxStoreIfAvailable();

    const articles = document.querySelectorAll('article[data-testid="tweet"]');
    for (let i = 0; i < articles.length; i += 1) {
      const article = articles[i];
      const { authorHandle, tweetId } = extractPrimaryAuthorAndTweetId(article);

      const previousAuthor = article.getAttribute("data-fo-author");
      if (previousAuthor && previousAuthor !== authorHandle) {
        article.removeAttribute("data-fo-following");
        article.removeAttribute("data-fo-promoted");
        article.removeAttribute("data-fo-suggested");
      }

      setOrRemoveAttr(article, "data-fo-author", authorHandle);

      let following = authorHandle ? followingByHandle.get(authorHandle) : undefined;
      const meta = tweetId ? tweetMetaById.get(tweetId) : undefined;

      if (typeof following !== "boolean" && typeof meta?.following === "boolean") {
        following = meta.following;
      }

      if (typeof following !== "boolean") {
        harvestFromArticleFiber(article);
        following = authorHandle ? followingByHandle.get(authorHandle) : meta?.following;
      }

      if (authorHandle && selfHandles.has(authorHandle)) {
        following = true;
      }

      if (typeof following === "boolean") {
        setOrRemoveAttr(article, "data-fo-following", following ? "true" : "false");
      } else {
        setOrRemoveAttr(article, "data-fo-following", null);
      }

      if (meta?.promoted) {
        setOrRemoveAttr(article, "data-fo-promoted", "true");
      }

      if (meta?.suggested && following !== true) {
        setOrRemoveAttr(article, "data-fo-suggested", "true");
      } else {
        setOrRemoveAttr(article, "data-fo-suggested", null);
      }
    }
  }

  function scheduleAnnotate() {
    if (annotateScheduled) return;
    annotateScheduled = true;
    queueMicrotask(annotateTweets);
  }

  function inspectApiUrl(url, responseText) {
    if (!url || !responseText) return;
    if (
      !url.includes("/graphql/") &&
      !url.includes("/friendships/create") &&
      !url.includes("/friendships/destroy") &&
      !url.includes("/timeline/")
    ) {
      return;
    }

    let friendshipOverride;
    if (url.includes("/friendships/create")) {
      friendshipOverride = true;
    } else if (url.includes("/friendships/destroy")) {
      friendshipOverride = false;
    }

    try {
      const parsed = JSON.parse(responseText);
      harvestPayload(parsed, friendshipOverride);
    } catch {
      // Ignore non-JSON responses.
    }
  }

  // Passively observe X's XMLHttpRequest GraphQL responses without altering network behavior.
  const originalXhrOpen = XMLHttpRequest.prototype.open;
  const originalXhrSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    try {
      this.__friendsOnlyUrl = typeof url === "string" ? url : String(url ?? "");
    } catch {
      // Ignore property assignment issues.
    }
    return originalXhrOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    try {
      const reqUrl = this.__friendsOnlyUrl || "";
      if (
        reqUrl.includes("/graphql/") ||
        reqUrl.includes("/friendships/") ||
        reqUrl.includes("/timeline/")
      ) {
        this.addEventListener("load", function () {
          try {
            if (this.responseType === "" || this.responseType === "text") {
              inspectApiUrl(reqUrl, this.responseText);
            } else if (this.responseType === "json" && this.response) {
              harvestPayload(this.response);
            }
          } catch {
            // Never disrupt X's XHR lifecycle.
          }
        });
      }
    } catch {
      // Ignore listener errors.
    }
    return originalXhrSend.apply(this, args);
  };

  // Also observe fetch() in case X routes GraphQL calls over fetch.
  if (typeof globalThis.fetch === "function") {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = function (...args) {
      const promise = originalFetch.apply(this, args);
      try {
        const rawInput = args[0];
        const reqUrl =
          typeof rawInput === "string"
            ? rawInput
            : rawInput && typeof rawInput.url === "string"
              ? rawInput.url
              : "";
        if (
          reqUrl.includes("/graphql/") ||
          reqUrl.includes("/friendships/") ||
          reqUrl.includes("/timeline/")
        ) {
          promise
            .then((res) => {
              if (res && typeof res.clone === "function") {
                res
                  .clone()
                  .text()
                  .then((text) => inspectApiUrl(reqUrl, text))
                  .catch(() => {});
              }
            })
            .catch(() => {});
        }
      } catch {
        // Ignore fetch wrapper errors.
      }
      return promise;
    };
  }

  const observer = new MutationObserver(() => {
    scheduleAnnotate();
  });

  observer.observe(document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["href"]
  });

  document.addEventListener("DOMContentLoaded", () => {
    scheduleAnnotate();
  });
})();
