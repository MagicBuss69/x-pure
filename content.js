// Content script injected at document_start on x.com (Chrome & Firefox).
// Handles:
// 1. Syncing the on/off toggle from storage.local
// 2. Detecting when the Home timeline is active (including behind compose/media modals)
// 3. Hiding "For you" and custom topic timeline tabs on Home and switching to "Following"
// 4. Watching X's dynamic virtualized DOM via MutationObserver to hide Ads ("Ad"/"Promoted"),
//    "Who to follow" modules, suggested posts, and any post not from a followed account

(() => {
  const ext = globalThis.browser ?? globalThis.chrome;
  const STORAGE_KEY = "enabled";
  const ROOT_ATTR = "data-friends-only";
  const HOME_ATTR = "data-friends-only-home";
  const FORYOU_ACTIVE_ATTR = "data-friends-only-foryou-active";
  const HIDDEN_ATTR = "data-friends-only-hidden";

  const AD_BADGE_RE = /^(ad|promoted|promoted\s+tweet|promoted\s+post|sponsored)$/i;
  const PROMOTED_BY_RE = /^promoted(\s+by\b|$)/i;
  const WHO_TO_FOLLOW_HEADING_RE =
    /^(who\s+to\s+follow|creators\s+for\s+you|subscribe\s+to\b|topics\s+to\s+follow|discover\s+more|more\s+posts|more\s+tweets)$/i;
  const SUGGESTED_SOCIAL_CONTEXT_RE =
    /\b(suggested(\s+for\s+you)?|popular(\s+in\s+your\s+network)?|based\s+on\s+your\s+likes|you\s+might\s+like|might\s+like|trending|liked|followed)\b/i;

  let isEnabled = true;
  let scanScheduled = false;
  let lastForYouSwitchAttempt = 0;
  let lastScrollNudgeTime = 0;

  function isElementNode(node) {
    return Boolean(node && node.nodeType === Node.ELEMENT_NODE);
  }

  /**
   * Determines whether the Home timeline is currently active.
   * Also returns true when a modal overlay (/compose/post or photo/video lightbox)
   * is open on top of the still-mounted Home timeline so background posts stay hidden.
   */
  function isOnHomeTimeline() {
    const path = window.location.pathname;
    if (path === "/home" || path === "/home/") {
      return true;
    }

    if (
      path.startsWith("/explore") ||
      path.startsWith("/search") ||
      path.startsWith("/hashtag")
    ) {
      return false;
    }

    const primary = document.querySelector('[data-testid="primaryColumn"]');
    if (!primary) {
      return false;
    }

    if (primary.querySelector('[aria-label="Timeline: Your Home Timeline"]')) {
      return true;
    }

    if (primary.querySelector('[role="tablist"] a[role="tab"][href="/home"]')) {
      return true;
    }

    return false;
  }

  function setBooleanRootAttr(attrName, active) {
    const root = document.documentElement;
    if (!root) return;

    if (active) {
      if (root.getAttribute(attrName) !== "true") {
        root.setAttribute(attrName, "true");
      }
    } else if (root.hasAttribute(attrName)) {
      root.removeAttribute(attrName);
    }
  }

  /**
   * Keeps html[data-friends-only] and html[data-friends-only-home] synced.
   * Safe at document_start in Firefox, where document.documentElement may be null
   * until the HTML parser creates <html>.
   */
  function syncRootAttributes() {
    const onHome = isOnHomeTimeline();
    setBooleanRootAttr(ROOT_ATTR, isEnabled);
    setBooleanRootAttr(HOME_ATTR, isEnabled && onHome);
    if (!isEnabled || !onHome) {
      setBooleanRootAttr(FORYOU_ACTIVE_ATTR, false);
    }
    return onHome;
  }

  // Optimistically enable CSS rules at document_start so unwanted posts never flash on /home.
  syncRootAttributes();

  function markHidden(el) {
    if (el && el.getAttribute(HIDDEN_ATTR) !== "true") {
      el.setAttribute(HIDDEN_ATTR, "true");
    }
  }

  function unmarkHidden(el) {
    if (el && el.hasAttribute(HIDDEN_ATTR)) {
      el.removeAttribute(HIDDEN_ATTR);
    }
  }

  /**
   * Keeps only the "Following" tab in the Home header tablist: hides "For you" and
   * any custom topic timeline tabs (e.g. Tech, Music, Gaming), suppresses non-Following
   * feed content if another Home tab is active, and switches to "Following".
   */
  function handleHomeTabs(primaryColumn) {
    if (!primaryColumn) {
      setBooleanRootAttr(FORYOU_ACTIVE_ATTR, false);
      return;
    }

    const tablist = primaryColumn.querySelector('[role="tablist"]');
    if (!tablist) {
      return;
    }

    const allTabs = Array.from(tablist.querySelectorAll('[role="tab"]'));
    if (allTabs.length === 0) {
      return;
    }

    let followingTab = null;

    for (const tab of allTabs) {
      const label = tab.textContent?.replace(/\s+/g, " ").trim().toLowerCase() || "";
      if (label === "following") {
        followingTab = tab;
        break;
      }
    }

    // Fallback for non-English UIs: X's second /home tab is "Following" (after "For you").
    if (!followingTab) {
      const homeTabs = allTabs.filter((tab) => tab.getAttribute("href") === "/home");
      if (homeTabs.length >= 2) {
        followingTab = homeTabs[1];
      }
    }

    if (!followingTab) {
      setBooleanRootAttr(FORYOU_ACTIVE_ATTR, false);
      return;
    }

    for (const tab of allTabs) {
      const wrapper = tab.closest('[role="presentation"]');
      const target =
        wrapper && wrapper.querySelectorAll('[role="tab"]').length === 1 ? wrapper : tab;
      if (tab === followingTab) {
        unmarkHidden(tab);
        if (wrapper) unmarkHidden(wrapper);
      } else {
        markHidden(target);
      }
    }

    // Hide horizontal tab-strip scroll arrows when only "Following" remains.
    tablist.parentElement
      ?.querySelectorAll(
        '[data-testid="ScrollSnap-prevButtonWrapper"], [data-testid="ScrollSnap-nextButtonWrapper"]'
      )
      .forEach(markHidden);

    const isNonFollowingSelected =
      followingTab.getAttribute("aria-selected") !== "true" &&
      allTabs.some((tab) => tab !== followingTab && tab.getAttribute("aria-selected") === "true");
    setBooleanRootAttr(FORYOU_ACTIVE_ATTR, isNonFollowingSelected);

    if (isNonFollowingSelected) {
      const now = Date.now();
      if (now - lastForYouSwitchAttempt > 600) {
        lastForYouSwitchAttempt = now;
        followingTab.click();
      }
    }
  }

  /**
   * Checks whether `node` sits inside an embedded quoted post rather than the outer post.
   */
  function isInsideQuotedPost(article, node) {
    const userNames = article.querySelectorAll('[data-testid="User-Name"]');
    if (userNames.length < 2) return false;

    const primaryUserName = userNames[0];
    let cur = node;
    while (cur && cur !== article) {
      if (
        (cur.getAttribute("role") === "link" || cur.hasAttribute("tabindex")) &&
        !cur.contains(primaryUserName) &&
        cur.querySelector('[data-testid="User-Name"]')
      ) {
        return true;
      }
      cur = cur.parentElement;
    }
    return false;
  }

  /**
   * Detects Ads / Promoted posts via placementTracking, page-bridge metadata,
   * or X's "Ad" / "Promoted" badges outside post body text and user names.
   */
  function isAdOrPromotedPost(article, cell) {
    if (article.getAttribute("data-fo-promoted") === "true") {
      return true;
    }

    if (
      article.querySelector('[data-testid="placementTracking"]') ||
      cell?.querySelector('[data-testid="placementTracking"]')
    ) {
      return true;
    }

    const spans = article.querySelectorAll("span");
    for (const span of spans) {
      if (span.children.length > 0) continue;
      const text = span.textContent?.trim();
      if (!text || text.length > 32) continue;
      if (!AD_BADGE_RE.test(text) && !PROMOTED_BY_RE.test(text)) continue;

      // Ignore body text, display names, link preview cards, polls, action counts, and quotes.
      if (
        span.closest(
          '[data-testid="tweetText"], [data-testid="User-Name"], [data-testid="card.wrapper"], [data-testid="cardPoll"], [role="group"]'
        )
      ) {
        continue;
      }
      if (isInsideQuotedPost(article, span)) {
        continue;
      }

      return true;
    }

    return false;
  }

  /**
   * Detects inline "Follow" / "Subscribe" CTA buttons on the outer tweet header,
   * carefully excluding "-unfollow" buttons rendered for already-followed accounts.
   */
  function hasUnfollowedActionOnPost(article) {
    const testIdCandidates = article.querySelectorAll('[data-testid$="-follow"]');
    for (const btn of testIdCandidates) {
      const testId = btn.getAttribute("data-testid") || "";
      if (testId.endsWith("-unfollow")) continue;
      if (!isInsideQuotedPost(article, btn)) {
        return true;
      }
    }

    const ariaFollowButtons = article.querySelectorAll(
      'button[aria-label^="Follow @"], [role="button"][aria-label^="Follow @"]'
    );
    for (const btn of ariaFollowButtons) {
      if (!isInsideQuotedPost(article, btn)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Detects algorithmic / suggested social contexts ("Suggested for you", "Popular",
   * "<User> liked", "<User> followed", Topic recommendations, etc.).
   */
  function hasSuggestedContext(article, cell) {
    if (article.getAttribute("data-fo-suggested") === "true") {
      return true;
    }

    // Topic header links injected above suggested topic posts.
    const scope = cell || article;
    const topicLinks = scope.querySelectorAll('a[href*="/i/topics/"]');
    for (const link of topicLinks) {
      if (!link.closest('[data-testid="tweetText"]') && !isInsideQuotedPost(article, link)) {
        return true;
      }
    }

    const socialContext =
      article.querySelector('[data-testid="socialContext"]') ||
      cell?.querySelector('[data-testid="socialContext"]');
    if (socialContext) {
      const text = socialContext.textContent?.replace(/\s+/g, " ").trim() || "";
      if (PROMOTED_BY_RE.test(text)) {
        return true;
      }
      // Keep reposts ("<Friend> reposted") and community labels from followed authors.
      if (
        !/\breposted$/i.test(text) &&
        !/\bpinned$/i.test(text) &&
        !socialContext.querySelector('a[href*="/i/communities/"]')
      ) {
        if (SUGGESTED_SOCIAL_CONTEXT_RE.test(text)) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Determines whether a post (`article[data-testid="tweet"]`) on the Home timeline
   * should be hidden because it is an ad, a suggested post, or not confirmed followed.
   */
  function shouldHideTweetArticle(article, cell) {
    if (isAdOrPromotedPost(article, cell)) {
      return true;
    }

    if (hasUnfollowedActionOnPost(article)) {
      return true;
    }

    if (hasSuggestedContext(article, cell)) {
      return true;
    }

    // Hide posts whose author is unfollowed ("false") or whose follow state is unknown.
    if (article.getAttribute("data-fo-following") !== "true") {
      return true;
    }

    return false;
  }

  /**
   * Determines whether a Home timeline cell (`div[data-testid="cellInnerDiv"]`) should be hidden.
   */
  function shouldHideTimelineCell(cell, previousCellWasHiddenModule) {
    if (!isElementNode(cell)) {
      return { hide: false, isModuleItem: false };
    }

    // Never hide the inline post composer or timeline loading indicators.
    if (
      cell.querySelector(
        '[data-testid="tweetTextarea_0"], [data-testid="toolBar"], [role="progressbar"]'
      )
    ) {
      return { hide: false, isModuleItem: false };
    }

    if (cell.querySelector('[data-testid="placementTracking"]')) {
      return { hide: true, isModuleItem: false };
    }

    // Inline "Who to follow" / "Creators for you" user rows and "Show more" footers.
    if (
      cell.querySelector('[data-testid="UserCell"]') ||
      cell.querySelector('a[href*="/connect_people"]') ||
      cell.querySelector('a[href*="/i/communities/suggested"]')
    ) {
      return { hide: true, isModuleItem: true };
    }

    const article = cell.querySelector('article[data-testid="tweet"]');
    if (article) {
      return {
        hide: shouldHideTweetArticle(article, cell),
        isModuleItem: false
      };
    }

    // Non-tweet module headers ("Who to follow", "Discover more", "Creators for you", etc.)
    // and non-tweet promoted banners.
    const headings = cell.querySelectorAll('h2, [role="heading"]');
    for (const heading of headings) {
      const text = heading.textContent?.replace(/\s+/g, " ").trim() || "";
      if (WHO_TO_FOLLOW_HEADING_RE.test(text)) {
        return { hide: true, isModuleItem: true };
      }
    }

    const cellText = cell.textContent?.replace(/\s+/g, " ").trim() || "";
    if (WHO_TO_FOLLOW_HEADING_RE.test(cellText) || PROMOTED_BY_RE.test(cellText)) {
      return { hide: true, isModuleItem: true };
    }

    // Trailing "Show more" footer cell directly underneath a hidden "Who to follow" module.
    if (previousCellWasHiddenModule && /^show\s+more$/i.test(cellText)) {
      return { hide: true, isModuleItem: true };
    }

    return { hide: false, isModuleItem: false };
  }

  /**
   * Hides right-sidebar "Who to follow" cards and sidebar ad placements while on Home.
   */
  function scanSidebar() {
    const sidebar = document.querySelector('[data-testid="sidebarColumn"]');
    if (!sidebar) return;

    sidebar.querySelectorAll('aside[aria-label="Who to follow" i]').forEach((aside) => {
      const parent = aside.parentElement;
      const target = parent && parent.children.length === 1 ? parent : aside;
      markHidden(target);
    });

    sidebar.querySelectorAll('[data-testid="placementTracking"]').forEach((adNode) => {
      const cell = adNode.closest('[data-testid="cellInnerDiv"]') || adNode;
      markHidden(cell);
    });
  }

  /**
   * Scans the current Home DOM to hide non-followed posts, ads, "Who to follow", and
   * "For you" tab content, while unmarking recycled virtualized cells when rebound to friends.
   */
  function scanPage() {
    scanScheduled = false;
    const onHome = syncRootAttributes();

    if (!isEnabled || !onHome) {
      document.querySelectorAll(`[${HIDDEN_ATTR}="true"]`).forEach(unmarkHidden);
      return;
    }

    const primaryColumn = document.querySelector('[data-testid="primaryColumn"]');
    handleHomeTabs(primaryColumn);
    scanSidebar();

    if (!primaryColumn) return;

    const cells = primaryColumn.querySelectorAll('[data-testid="cellInnerDiv"]');
    let previousCellWasHiddenModule = false;
    let newlyHiddenCount = 0;

    for (const cell of cells) {
      const wasHidden = cell.getAttribute(HIDDEN_ATTR) === "true";
      const { hide, isModuleItem } = shouldHideTimelineCell(cell, previousCellWasHiddenModule);

      if (hide) {
        if (!wasHidden) newlyHiddenCount += 1;
        markHidden(cell);
      } else if (wasHidden) {
        unmarkHidden(cell);
      }

      previousCellWasHiddenModule = hide && isModuleItem;
    }

    // Also support non-virtualized standalone article[data-testid="tweet"] containers if X renders any.
    primaryColumn
      .querySelectorAll('article[data-testid="tweet"]')
      .forEach((article) => {
        if (article.closest('[data-testid="cellInnerDiv"]')) return;
        if (shouldHideTweetArticle(article, null)) {
          markHidden(article);
        } else {
          unmarkHidden(article);
        }
      });

    // If collapsing several consecutive ads/suggestions makes the document shorter than
    // the viewport, nudge X's scroll listener so infinite scroll fetches more friend posts.
    if (
      newlyHiddenCount > 0 &&
      document.documentElement.scrollHeight <= window.innerHeight * 1.5 &&
      Date.now() - lastScrollNudgeTime > 500
    ) {
      lastScrollNudgeTime = Date.now();
      window.dispatchEvent(new Event("scroll"));
    }
  }

  /**
   * Batches rapid DOM mutations while scrolling into a single scan per animation frame.
   */
  function scheduleScan() {
    syncRootAttributes();
    if (!isEnabled || scanScheduled) return;
    scanScheduled = true;
    requestAnimationFrame(scanPage);
  }

  function applyEnabledState(enabled) {
    isEnabled = Boolean(enabled);
    syncRootAttributes();

    if (isEnabled) {
      scanPage();
    } else {
      document.querySelectorAll(`[${HIDDEN_ATTR}="true"]`).forEach(unmarkHidden);
    }
  }

  // Observe `document` so MutationObserver never fails at document_start in Firefox
  // before the root <html> element has been parsed.
  const observer = new MutationObserver(() => {
    scheduleScan();
  });

  observer.observe(document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [
      "aria-selected",
      "href",
      "data-fo-following",
      "data-fo-promoted",
      "data-fo-suggested"
    ]
  });

  document.addEventListener("DOMContentLoaded", () => {
    scheduleScan();
  });

  window.addEventListener("popstate", () => {
    scheduleScan();
  });

  // Load saved toggle state from storage.local (Promise API works in both Chrome & Firefox MV3).
  ext.storage.local.get({ [STORAGE_KEY]: true }).then((result) => {
    applyEnabledState(result[STORAGE_KEY] !== false);
  });

  ext.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && changes[STORAGE_KEY]) {
      applyEnabledState(changes[STORAGE_KEY].newValue !== false);
    }
  });

  // Allow the popup to query how many items are currently hidden on this tab.
  ext.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "GET_FRIENDS_ONLY_STATUS") {
      const onHome = isOnHomeTimeline();
      const hiddenCount =
        isEnabled && onHome ? document.querySelectorAll(`[${HIDDEN_ATTR}="true"]`).length : 0;
      sendResponse({
        enabled: isEnabled,
        hiddenCount,
        isX: true,
        isHome: onHome
      });
    }
  });
})();
