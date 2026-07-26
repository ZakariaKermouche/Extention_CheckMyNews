// content-scripts/interaction-tracker.js

(function () {
  if (!location.hostname.includes("facebook.com")) return;

  const CLICK_THROTTLE_MS = 300; // Only applied to non-reaction clicks
  const MOVE_THROTTLE_MS = 1000;

  let lastClick = 0;
  let lastMove = 0;
  let lastHoveredPostContext = null;  // fallback: last post hovered
  let lastPointerDownContext = null;  // fallback: captured BEFORE React portal appears

  // ─── Pending interactions (waiting for dbId) ──────────────────────────────
  const pendingInteractions = [];

  setInterval(() => {
    if (pendingInteractions.length === 0) return;
    const cmn = window.CMN;
    if (!cmn || !cmn.graphqlPostsMap) return;

    const remaining = [];
    const now = Date.now();

    for (const interaction of pendingInteractions) {
      // 1. Direct lookup by stored postId
      let postData = cmn.graphqlPostsMap.get(interaction.postId);

      // 2. Alias lookup (handles 98…/99… ↔ pfbid mismatch)
      if (!postData) {
        for (const [, pd] of cmn.graphqlPostsMap.entries()) {
          if (
            pd.post_id === interaction.postId ||
            pd.id === interaction.postId ||
            pd.original_graphql_id === interaction.postId
          ) {
            postData = pd;
            break;
          }
        }
      }

      const dbId = postData?.dbId;

      if (dbId) {
        // console.log(`[CMN-Tracker] Sending delayed ${interaction.eventType} → dbId:${dbId}`);
        try {
          if (chrome?.runtime?.id) {
            chrome.runtime.sendMessage({
              type: interaction.type,
              dbId,
              eventType: interaction.eventType,
              postId: interaction.postId,
              adId: interaction.adId,
              timestamp: interaction.timestamp,
              advertiserLifecycleHandled: interaction.advertiserLifecycleHandled,
              authorId: interaction.authorId,
              authorName: interaction.authorName,
              authorUrl: interaction.authorUrl,
              authorImage: interaction.authorImage,
            }).catch(() => { });
          }
        } catch (_) { }
      } else if (now - interaction.timestamp < 60000) {
        remaining.push(interaction); // keep for up to 60 s
      } else {
        console.warn("[CMN-Tracker] Dropping stale interaction — no dbId for", interaction.postId);
      }
    }

    pendingInteractions.length = 0;
    pendingInteractions.push(...remaining);
  }, 2000);

  // ─── Helpers ──────────────────────────────────────────────────────────────

  function nowMs() {
    return Date.now();
  }

  function getTimeElapsed() {
    if (typeof performance?.now === "function") return Math.floor(performance.now());
    return 0;
  }

  function getWindowSnapshot() {
    return {
      width: window.innerWidth,
      height: window.innerHeight,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      url: window.location.href,
    };
  }

  function getRectSnapshot(el) {
    if (!(el instanceof Element)) return {};
    const rect = el.getBoundingClientRect();
    return {
      top: Math.round(rect.top),
      left: Math.round(rect.left),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  }

  function cleanFacebookUrl(url) {
    if (!url) return null;
    try {
      const u = new URL(url, window.location.origin);
      if (u.pathname === "/profile.php" && u.searchParams.get("id")) {
        return `${u.origin}/profile.php?id=${u.searchParams.get("id")}`;
      }
      const parts = u.pathname.split("/").filter(Boolean);
      if (parts[0] && !FACEBOOK_NON_PAGE_PATHS.has(parts[0].toLowerCase())) {
        return `${u.origin}/${parts[0]}`;
      }
      return `${u.origin}${u.pathname === "/" ? "" : u.pathname}`;
    } catch (_) {
      return String(url).split("?")[0] || null;
    }
  }

  const FACEBOOK_NON_PAGE_PATHS = new Set([
    "about", "ads", "adsmanager", "bookmarks", "events", "friends", "groups",
    "hashtag", "help", "home", "marketplace", "messages", "notifications",
    "pages", "permalink.php", "photo", "photos", "plugins", "posts", "profile.php",
    "reel", "reels", "search", "settings", "share", "sharer", "stories",
    "story.php", "videos", "watch"
  ]);

  const ADVERTISER_ACTIVE_UNTIL = 4102444800; // 2100-01-01 UTC

  const BAD_AUTHOR_NAMES = new Set([
    "ad", "ads", "follow", "like", "photos", "photo", "posts", "reels",
    "videos", "watch", "sponsored", "sponsorisé", "suivre", "home",
    "facebook", "accueil", "home", "following"
  ]);

  function isProbablyFacebookPageUrl(url) {
    if (!url) return false;
    try {
      const u = new URL(url, window.location.origin);
      if (!/facebook\.com$/i.test(u.hostname.replace(/^www\./, ""))) return false;
      if (u.pathname === "/profile.php") return !!u.searchParams.get("id");
      const parts = u.pathname.split("/").filter(Boolean).map((p) => p.toLowerCase());
      const first = parts[0];
      if (!first) return false;
      if (FACEBOOK_NON_PAGE_PATHS.has(first)) return false;
      if (parts[1] && FACEBOOK_NON_PAGE_PATHS.has(parts[1])) return false;
      return true;
    } catch (_) {
      return false;
    }
  }

  function cleanAuthorName(raw) {
    let name = (raw || "").replace(/\s+/g, " ").trim();
    if (!name) return null;
    name = name
      .replace(/^(profile of|profil de|profile for)\s+/i, "")
      .replace(/\s+(profile|profil)$/i, "")
      .replace(/\b(follow|suivre|sponsored|sponsorisé|ad)\b\s*$/i, "")
      .trim();
    const lower = name.toLowerCase();
    if (!name || BAD_AUTHOR_NAMES.has(lower)) return null;
    if (name.length > 120) return null;
    return name;
  }

  function extractFacebookIdFromUrl(url) {
    if (!url) return null;
    try {
      const u = new URL(url, window.location.origin);
      const profileId = u.searchParams.get("id");
      if (profileId) return profileId;
      const parts = u.pathname.split("/").filter(Boolean);
      if (parts[0] === "stories" && parts[1]) return parts[1];
      if (parts[0] && !FACEBOOK_NON_PAGE_PATHS.has(parts[0].toLowerCase())) {
        return parts[0];
      }
    } catch (_) { }
    const idMatch = String(url).match(/[?&]id=(\d+)/);
    return idMatch?.[1] || null;
  }

  function getPostElementForTarget(target, matchedElement) {
    return target?.closest?.('[role="article"]') || matchedElement?.closest?.('[role="article"]') || matchedElement || null;
  }

  function getIdFromLinkMetadata(link) {
    const attrs = [
      link.getAttribute("data-hovercard"),
      link.getAttribute("ajaxify"),
      link.getAttribute("data-lynx-uri"),
      link.getAttribute("href"),
      link.href,
    ].filter(Boolean);
    for (const val of attrs) {
      const match = String(val).match(/[?&](?:id|page_id)=(\d+)/);
      if (match?.[1]) return match[1];
    }
    return null;
  }

  function getDomAuthor(postElement) {
    const cmn = window.CMN;
    if (!postElement) return null;

    const articleRect = postElement.getBoundingClientRect?.() || null;
    const links = Array.from(postElement.querySelectorAll('h2 a[href], h3 a[href], h4 a[href], [data-ad-rendering-role="profile_name"] a[href], a[aria-label][href]'));
    const candidates = [];

    for (const link of links) {
      const href = link.href || link.getAttribute("href");
      if (!href) continue;
      if (!isProbablyFacebookPageUrl(href)) continue;

      const url = cleanFacebookUrl(href);
      const id = getIdFromLinkMetadata(link) || extractFacebookIdFromUrl(href);
      const name = cleanAuthorName(link.textContent || link.getAttribute("aria-label") || "");
      if (!id && !url) continue;

      let score = 0;
      if (link.closest("h2, h3, h4")) score += 50;
      if (link.closest('[data-ad-rendering-role="profile_name"]')) score += 40;
      if (link.hasAttribute("data-hovercard")) score += 20;
      if (name) score += 20;
      if (/^\d+$/.test(String(id || ""))) score += 15;
      try {
        const rect = link.getBoundingClientRect();
        if (articleRect && rect.top <= articleRect.top + 180) score += 15;
      } catch (_) { }

      candidates.push({ id, url, name, score });
    }

    candidates.sort((a, b) => b.score - a.score);
    if (candidates[0]) return candidates[0];

    try {
      if (cmn?.extractAuthorMetadataFromElement) {
        const author = cmn.extractAuthorMetadataFromElement(postElement);
        const url = cleanFacebookUrl(author?.url);
        const name = cleanAuthorName(author?.name);
        if (isProbablyFacebookPageUrl(url) && (author?.id || url || name)) {
          return {
            id: author.id || extractFacebookIdFromUrl(url),
            url,
            name,
          };
        }
      }
    } catch (_) { }

    return null;
  }

  function isUsableAdvertiserValue({ id, url, name }) {
    if (!id && !url) return false;
    if (url && !isProbablyFacebookPageUrl(url)) return false;
    if (name && BAD_AUTHOR_NAMES.has(String(name).toLowerCase())) return false;
    if (id && FACEBOOK_NON_PAGE_PATHS.has(String(id).toLowerCase())) return false;
    return true;
  }

  function firstUsableAdvertiser(...candidates) {
    for (const c of candidates) {
      if (isUsableAdvertiserValue(c || {})) return c;
    }
    return null;
  }

  function getAdvertiserContext(postData, postElement) {
    const registerPayload = postData?.register_ad_payload || {};
    const domAuthor = getDomAuthor(postElement);
    const selected = firstUsableAdvertiser(
      {
        id: domAuthor?.id,
        url: cleanFacebookUrl(domAuthor?.url),
        name: cleanAuthorName(domAuthor?.name),
      },
      {
        id: registerPayload.advertiser_facebook_id,
        url: cleanFacebookUrl(registerPayload.advertiser_facebook_page),
        name: cleanAuthorName(registerPayload.name),
      },
      {
        id: postData?.author?.id,
        url: cleanFacebookUrl(postData?.author?.url || postData?.author?.page),
        name: cleanAuthorName(postData?.author?.name),
      }
    ) || {};
    const url = cleanFacebookUrl(selected.url);
    return {
      id: selected.id || extractFacebookIdFromUrl(url) || null,
      name: selected.name || null,
      url,
      image: postData?.author?.profile_picture || postData?.author?.image || registerPayload.advertiser_facebook_profile_pic || null,
      category: registerPayload.category || "",
      primaryCategory: registerPayload.primary_category || "",
    };
  }

  function getCurrentPageAdvertiserContext() {
    const pageUrl = cleanFacebookUrl(window.location.href);
    if (!isProbablyFacebookPageUrl(pageUrl)) return null;

    let name = null;
    const main = document.querySelector('[role="main"]') || document.body;
    const selectors = [
      'h1 span[dir="auto"]',
      'h1',
      '[data-ad-rendering-role="profile_name"] span[dir="auto"]',
      'meta[property="og:title"]',
    ];

    for (const selector of selectors) {
      const el = document.querySelector(selector);
      const raw = el?.tagName === "META" ? el.getAttribute("content") : el?.textContent;
      name = cleanAuthorName(raw);
      if (name) break;
    }

    if (!name && main) {
      const heading = Array.from(main.querySelectorAll('h1, h2')).find((el) => {
        const text = cleanAuthorName(el.textContent);
        return text && !BAD_AUTHOR_NAMES.has(text.toLowerCase());
      });
      name = cleanAuthorName(heading?.textContent);
    }

    return {
      postId: null,
      dbId: null,
      adId: null,
      advertiserId: extractFacebookIdFromUrl(pageUrl),
      authorId: extractFacebookIdFromUrl(pageUrl),
      authorName: name,
      authorUrl: pageUrl,
      authorImage: null,
      authorCategory: "",
      authorPrimaryCategory: "",
      lastAdPosition: {},
      imagePosition: {},
      source: "current_page",
    };
  }

  function buildAdvertiserLifecyclePayload(context, action = "follow") {
    if (!context?.advertiserId && !context?.authorUrl) return null;
    const nowSeconds = Math.floor(Date.now() / 1000);
    const isFollow = action === "follow";
    return {
      advertiser_identifier: context.advertiserId || extractFacebookIdFromUrl(context.authorUrl),
      is_facebook_page: "YES",
      global_brand_root_id: 0,
      link: context.authorUrl || null,
      name: context.authorName || "",
      category: context.authorCategory || "",
      image_url: context.authorImage || "",
      likes: 0,
      no_ads: 0,
      added_on: isFollow ? nowSeconds : -1,
      last_appearance: ADVERTISER_ACTIVE_UNTIL,
      primary_category: context.authorPrimaryCategory || "",
    };
  }

  function sendAdvertiserLifecycle(context, action = "follow") {
    if (action === "unfollow") {
      const advertiserId = context.advertiserId || extractFacebookIdFromUrl(context.authorUrl);
      if (!advertiserId) {
        console.warn("[CMN-Tracker] Unfollow skipped: missing advertiser identifier", context);
        return;
      }
      console.log("[CMN-Tracker] Registering Unfollow action for ID:", advertiserId);
      try {
        if (chrome?.runtime?.id) {
          chrome.runtime.sendMessage({
            type: "REGISTER_UNFOLLOW_ADVERTISER",
            advertiserId,
            postId: context.postId,
            timestamp: Date.now(),
          }).catch(() => { });
        }
      } catch (_) { }
      return;
    }

    const payload = buildAdvertiserLifecyclePayload(context, action);
    if (!payload?.advertiser_identifier) {
      console.warn("[CMN-Tracker] Advertiser lifecycle registration skipped: missing advertiser identifier", {
        action,
        postId: context?.postId || null,
        link: payload?.link || context?.authorUrl || null,
        name: payload?.name || context?.authorName || null,
      });
      return;
    }
    console.log("[CMN-Tracker] Registering advertiser lifecycle action:", {
      action,
      name: payload.name || payload.advertiser_identifier,
      id: payload.advertiser_identifier,
      source: context.source
    });
    try {
      if (chrome?.runtime?.id) {
        chrome.runtime.sendMessage({
          type: "REGISTER_FOLLOW_ADVERTISER",
          payload,
          postId: context.postId,
          timestamp: Date.now(),
        }).catch(() => { });
      }
    } catch (_) { }
  }

  // ─── Click type inference ─────────────────────────────────────────────────
  // Uses aria-label (primary) + text content (fallback), walking up 12 levels.

  function isFollowButtonTarget(target) {
    let el = target;
    for (let i = 0; i < 20 && el; i++) {
      const tag = el.tagName?.toLowerCase();
      const role = (el.getAttribute?.("role") || "").toLowerCase();
      const isButtonLike = tag === "button" || role === "button";
      const isLink = tag === "a";

      if (isButtonLike && !isLink) {
        const ariaLabel = (el.getAttribute?.("aria-label") || "").trim().toLowerCase();
        const text = (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
        const combined = `${ariaLabel} ${text}`.trim();

        // Strict check: must contain follow/suivre but NOT be the settings title or update button
        // Strict check: must contain follow/suivre but NOT following/abonné, and NOT settings title or update button
        const isFollow = /\b(follow|suivre)\b/i.test(combined) && !/\b(following|abonné|déjà suivi)\b/i.test(combined);
        if (isFollow && !combined.includes("settings") && !combined.includes("paramètres") && !combined.includes("update") && !combined.includes("mettre à jour")) {
          console.log("[CMN-Debug] Matched Follow button:", { combined, ariaLabel, text });
          return true;
        }
      }
      el = el.parentElement;
    }
    return false;
  }

  function isUnfollowButtonTarget(target) {
    let el = target;
    for (let i = 0; i < 20 && el; i++) {
      const tag = el.tagName?.toLowerCase();
      const role = (el.getAttribute?.("role") || "").toLowerCase();
      const isActionLike = tag === "button" || role === "button" || role === "menuitem" || role === "radio" || role === "listitem" || role === "presentation";
      const isLink = tag === "a";

      if (isActionLike && !isLink) {
        const ariaLabel = (el.getAttribute?.("aria-label") || "").trim().toLowerCase();
        const text = (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
        const combined = `${ariaLabel} ${text}`.trim();

        // 1. Direct radio button, menu item, or "Following" button click
        const isUnfollowText = /\bunfollow/i.test(combined) || /\bne plus suivre/i.test(combined) || 
                               /\bse d[ée]sabonner/i.test(combined) || /\b(following|abonné|déjà suivi)\b/i.test(combined);
                               
        if (isUnfollowText) {
          return true;
        }

        // 2. "Update" button in a dialog where "Unfollow" is selected
        const isUpdateAction = combined.includes("update") || 
                               combined.includes("confirm") || 
                               combined.includes("mettre à jour") || 
                               combined.includes("confirmer");
                               
        if (isUpdateAction) {
          const dialog = el.closest('[role="dialog"]');
          if (dialog) {
            const selectedRadio = dialog.querySelector('[role="radio"][aria-checked="true"]');
            const radioText = (selectedRadio?.textContent || "").toLowerCase();
            if (/\bunfollow\b/.test(radioText) || /\bne plus suivre\b/.test(radioText) || /\bdésabonner\b/.test(radioText)) {
              return true;
            }
          }
        }
      }

      el = el.parentElement;
    }

    return false;
  }

  function inferClickType(target) {
    if (!target) return "ImageClicked";

    // 0. Explicitly ignore "See more" / "Voir plus" clicks
    const targetText = (target.textContent || "").toLowerCase().trim();
    if (targetText === "see more" || targetText === "voir plus") {
      return "SeeMoreClicked";
    }

    if (isUnfollowButtonTarget(target)) return "Unfollow";
    if (isFollowButtonTarget(target)) return "Follow";

    // 1. External / landing-page links
    const anchor = target.closest?.("a");
    if (anchor?.href) {
      const href = anchor.href.toLowerCase();
      if (
        href.includes("l.facebook.com") ||
        href.includes("l.php") ||
        (!href.includes("facebook.com") && href.startsWith("http"))
      ) return "VisitingLandingURL";

      if (href.includes("/photo") || href.includes("/video") || href.includes("/reel")) {
        return "ImageClicked";
      }
    }

    // 2. Walk up DOM looking for reaction/action aria-labels
    let el = target;
    for (let i = 0; i < 12 && el; i++) {
      const ariaLabel = (el.getAttribute?.("aria-label") || "").toLowerCase().trim();

      let tooltipText = "";
      try {
        const descId = el.getAttribute?.("aria-describedby");
        if (descId) {
          const descEl = document.getElementById(descId);
          if (descEl) tooltipText = descEl.textContent.toLowerCase().trim();
        }
      } catch (_) { }

      // Short text only (avoid grabbing the whole post body)
      let text = (el.textContent || "").trim().toLowerCase();
      if (text.length > 50) text = "";

      const combined = `${ariaLabel} ${tooltipText} ${text}`;

      // Reactions — test aria-label first (most reliable)
      // Reactions — test aria-label first (most reliable)
      if (/\blike\b|\bj.?aime\b/.test(ariaLabel)) return "Like";
      if (/\blove\b|\badore\b/.test(ariaLabel)) return "Love";
      if (/\bhaha\b/.test(ariaLabel)) return "Haha";
      if (/\bwow\b|\bwouah\b/.test(ariaLabel)) return "Wow";
      if (/\bcare\b|\bsolidaire\b/.test(ariaLabel)) return "Care";
      if (/\bsad\b|\btriste\b/.test(ariaLabel)) return "Sad";
      if (/\bangry\b|\bcolère\b/.test(ariaLabel)) return "Angry";

      // Actions
      if (/\bcomment(er)?\b/.test(combined)) return "CommentButtonClick";
      if (/\bpartag(er|e)\b|\bshare\b|\bsend\b/.test(combined)) return "Share";

      // Reaction fallback from combined text
      if (/\blike\b|\bj.?aime\b/.test(combined)) return "Like";
      if (/\blove\b|\badore\b/.test(combined)) return "Love";
      if (/\bhaha\b/.test(combined)) return "Haha";
      if (/\bwow\b|\bwouah\b/.test(combined)) return "Wow";
      if (/\bcare\b|\bsolidaire\b/.test(combined)) return "Care";
      if (/\bsad\b|\btriste\b/.test(combined)) return "Sad";
      if (/\bangry\b|\bcolère\b/.test(combined)) return "Angry";

      el = el.parentElement;
    }

    // 3. Image / video element
    if (
      target.closest?.("img") ||
      target.tagName?.toLowerCase() === "canvas" ||
      target.closest?.("video")
    ) return "ImageClicked";

    return "ImageClicked";
  }

  // ─── Post context lookup ──────────────────────────────────────────────────
  // Mirrors the reference implementation: walk up the DOM calling
  // cmn.extractPostIdFromElement() on each ancestor element.

  function getPostContextFromTarget(target) {
    const cmn = window.CMN;
    if (!cmn || !target) return null;

    const originalTarget = target;
    let el = target instanceof HTMLElement ? target : target?.parentElement;
    let postId = null;
    let matchedElement = null;

    // Walk up to 50 levels; use cmn.extractPostIdFromElement (same as ref impl)
    // This checks data-post-id / data-ft / link hrefs on each ancestor.
    for (let i = 0; el && i < 50; i++) {
      // Primary: use the shared extractor exposed by fbMain
      if (cmn.extractPostIdFromElement) {
        postId = cmn.extractPostIdFromElement(el);
        if (postId) {
          matchedElement = el;
          break;
        }
      }

      // Secondary: check if this element IS a tracked post root in domElementByPostId
      if (cmn.domElementByPostId) {
        for (const [id, element] of cmn.domElementByPostId.entries()) {
          if (element === el) {
            postId = id;
            matchedElement = el;
            break;
          }
        }
        if (postId) break;
      }

      // Tertiary: explicit data attributes
      if (el.getAttribute) {
        const direct =
          el.getAttribute("data-post-id") ||
          el.getAttribute("data-story-id") ||
          el.getAttribute("data-feed-item-id");
        if (direct) { postId = direct; matchedElement = el; break; }
      }

      el = el.parentElement;
    }

    if (!postId) return null;

    let postData = null;
    if (cmn.graphqlPostsMap instanceof Map) {
      postData = cmn.graphqlPostsMap.get(postId) || null;

      // Alias resolution
      if (!postData) {
        for (const [, pd] of cmn.graphqlPostsMap.entries()) {
          if (pd.post_id === postId || pd.id === postId || pd.original_graphql_id === postId) {
            postData = pd;
            break;
          }
        }
      }
    }

    const postElement = getPostElementForTarget(originalTarget, matchedElement || el);
    const advertiser = getAdvertiserContext(postData, postElement);

    return {
      postId,
      dbId: postData?.dbId || null,
      adId: postData?.ad?.ad_id || null,
      advertiserId: advertiser.id,
      authorId: advertiser.id,
      authorName: advertiser.name,
      authorUrl: advertiser.url,
      authorImage: advertiser.image,
      authorCategory: advertiser.category,
      authorPrimaryCategory: advertiser.primaryCategory,
      lastAdPosition: getRectSnapshot(postElement || matchedElement || el),
      imagePosition: getRectSnapshot(target?.closest?.("img")),
    };
  }

  // ─── Hover tracking (for React portal fallback) ───────────────────────────

  let hoverContextTimer = null;
  document.addEventListener("mouseover", (event) => {
    if (hoverContextTimer) clearTimeout(hoverContextTimer);
    hoverContextTimer = setTimeout(() => {
      const ctx = getPostContextFromTarget(event.target);
      if (ctx?.postId) lastHoveredPostContext = ctx;
    }, 50);
  }, { passive: true });

  // Pointerdown fires BEFORE any React popup opens — capture context here.
  document.addEventListener("pointerdown", (event) => {
    const ctx = getPostContextFromTarget(event.target);
    if (ctx?.postId) lastPointerDownContext = ctx;
  }, { passive: true, capture: true });

  // ─── Click handler ────────────────────────────────────────────────────────

  document.addEventListener("click", (event) => {
    const ts = nowMs();

    // Ignore programmatic clicks (e.g., auto-expansion of "See more" buttons)
    if (event.isTrusted === false) return;

    const clickType = inferClickType(event.target);
    if (clickType === "SeeMoreClicked") return;

    // Resolve context. For Follow/Unfollow on a page, stale feed fallbacks can point to
    // the post the user came from, so use the current page first.
    // Resolve context.
    let context = getPostContextFromTarget(event.target);
    if (clickType === "Follow" || clickType === "Unfollow") {
      context = getCurrentPageAdvertiserContext() || context;
    }
    
    // Fallback to last known context if still null (crucial for detached menus/portals)
    if (!context) context = lastPointerDownContext;
    if (!context) context = lastHoveredPostContext;
    if (!context) return;

    // Throttle only generic (non-reaction) clicks
    const isReactionClick = clickType !== "ImageClicked";
    if (!isReactionClick) {
      if (ts - lastClick < CLICK_THROTTLE_MS) return;
      lastClick = ts;
    }

    const { postId, adId, dbId } = context;
    /* if (clickType === "ImageClicked" && (event.target.textContent || "").toLowerCase().includes("follow")) {
      console.log("[CMN-Debug] Misidentified follow/unfollow click:", {
        target: event.target,
        textContent: event.target.textContent,
        ariaLabel: event.target.getAttribute?.("aria-label"),
        role: event.target.getAttribute?.("role")
      });
    } */
    // console.log(`[CMN-Tracker] ${clickType} | postId=${postId} | dbId=${dbId}`);

    if (clickType === "Follow" || clickType === "Unfollow") {
      sendAdvertiserLifecycle(context, clickType === "Follow" ? "follow" : "unfollow");
    }

    if (!dbId) {
      // Queue and force-register the post so we receive a dbId quickly
      pendingInteractions.push({
        type: "mouseClick",
        eventType: clickType,
        postId,
        adId,
        timestamp: ts,
        advertiserLifecycleHandled: clickType === "Follow" || clickType === "Unfollow",
        advertiserId: context.advertiserId,
        authorId: context.authorId,
        authorName: context.authorName,
        authorUrl: context.authorUrl,
        authorImage: context.authorImage,
      });

      const cmn = window.CMN;
      if (cmn?.graphqlPostsMap) {
        const postData = cmn.graphqlPostsMap.get(postId);
        if (postData) {
          postData._forceQueue = true;
          if (cmn.queuePostForSending) cmn.queuePostForSending(postData);
          if (cmn.storageManager?.sendData) cmn.storageManager.sendData();
          postData._forceQueue = false;
        }
      }
      
      // If it's a Follow/Unfollow, we proceed to send the message immediately so the 
      // advertiser can be registered, even if we don't have a dbId for the click yet.
      if (clickType !== "Follow" && clickType !== "Unfollow") return;
    }

    try {
      if (chrome?.runtime?.id) {
        chrome.runtime.sendMessage({
          type: "mouseClick",
          dbId,
          eventType: clickType,
          postId,
          adId,
          timestamp: ts,
          advertiserLifecycleHandled: clickType === "Follow" || clickType === "Unfollow",
          advertiserId: context.advertiserId,
          authorId: context.authorId,
          authorName: context.authorName,
          authorUrl: context.authorUrl,
          authorImage: context.authorImage,
        }).catch(() => { });
      }
    } catch (_) { }
  }, true); // capture phase

  // ─── Mouse move handler ───────────────────────────────────────────────────

  document.addEventListener("mousemove", (event) => {
    const ts = nowMs();
    if (ts - lastMove < MOVE_THROTTLE_MS) return;
    lastMove = ts;

    const context = getPostContextFromTarget(event.target) || lastHoveredPostContext;
    if (!context?.dbId) return;

    const { dbId, adId, lastAdPosition, imagePosition } = context;

    try {
      if (chrome?.runtime?.id) {
        chrome.runtime.sendMessage({
          type: "mouseMove",
          dbId,
          timeElapsed: getTimeElapsed(),
          frames: [{ x: event.clientX, y: event.clientY, ts }],
          window: getWindowSnapshot(),
          lastAdPosition,
          imagePosition,
          timestamp: ts,
        }).catch(() => { });
      }
    } catch (_) { }
  }, { passive: true });
})();
