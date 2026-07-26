// content-scripts/fbMain.js - FULLY FIXED VERSION

/**
 * CheckMyNewsMain - Cœur du moteur d'extraction Facebook.
 * Gère le pipeline d'interception, détection, fusion et persistance.
 */
(function () {
  console.log("[CMN] fbMain.js heartbeat: Script is loaded and executing.");
  if (!location.hostname.includes("facebook.com")) {
    console.warn("[CMN] fbMain.js heartbeat: Not on Facebook, exiting.");
    return;
  }

  try {
    class CheckMyNewsMain {
      constructor() {
        // Components
        this.observer = null;
        this.postDetector = null;
        this.dataExtractor = null;
        this.newsFilter = null;
        this.storageManager = null;
        this.messageHandler = null;
        this.bootstrapBridge = null;
        this.visibilityTracker = null;
        this.adActivityTracker = null;

        /**
         * THE PIPELINE ARCHITECTURE:
         * 1. Discovery: FBObserver finds posts in the DOM (Feed or Profile).
         * 2. Indexing: Posts are matched with GraphQL data (if available) and stored in graphqlPostsMap.
         * 3. Visibility Gate: Posts are NOT sent to the DB yet. They are passed to VisibilityTracker.
         * 4. Ingestion: Once a post is visible on screen for >100ms, handlePostsVisible is triggered.
         * 5. Persistence: Post is moved to cmn_unsent_posts and sent to the backend.
         */

        // State
        this.monitoring = false;
        this.initialized = false;
        this.graphqlPostsMap = new Map();
        this.domPostsInProcess = new Map();
        this.pendingDomByFingerprint = new Map();
        this.processingFingerprints = new Set(); // Mutex to avoid duplicate DOM posts created in parallel
        this.docIdPrimeAttempts = new Set();
        this.authorCache = new Map(); // fingerprint -> { name, url, id }
        this.idToAuthorNameCache = new Map(); // profile ID -> author name


        // Config
        this.config = {
          enabled: true,
          debugMode: false,
          collectSponsored: true,
          autoStart: true,
          explanationsEnabled: false,
          silentExplanationFetch: false,
          collectAdActivity: false,
        };

        // Stats
        this.stats = {
          postsDetected: 0,
          newsPostsCollected: 0,
          adsCollected: 0,
          regularPostsIgnored: 0,
          errors: 0,
          graphqlPostsReceived: 0,
          postsFoundInDOM: 0,
          explanationsTriggered: 0,
        };

        this.fingerprintIndex = new Map(); // fingerprint -> Set of post_ids
        this.domElementByPostId = new Map(); // postId -> HTMLElement (best-effort)
      }

      normalizeStringForFingerprint(text) {
        if (!text) return "";
        return (
          text
            .toLowerCase()
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/[\u200B-\u200D\uFEFF]/g, "")
            // Strip Arabic diacritics and tatweel to improve matching.
            .replace(/[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g, "")
            // STRIP DYNAMIC FB CONTENT: common time markers and "See more" labels
            .replace(/\b(just now|now|min|mins|h|hrs|d|days|w|weeks|y|yrs|yesterday|today|hier|aujourd'hui|voir plus|see more)\b/g, "")
            // Keep letters/numbers, drop punctuation.
            .replace(/[^\p{L}\p{N}\s]/gu, "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 48)
        );
      }

      buildFingerprint({ authorName, groupName, message }) {
        const normalizedMessage = this.normalizeStringForFingerprint(message);
      if (normalizedMessage && normalizedMessage.length > 5) {
        return normalizedMessage;
      }
      const normalizedAuthor = this.normalizeStringForFingerprint(authorName);
      if (normalizedAuthor) {
        return `author:${normalizedAuthor}`;
      }
      return null;
      }

      registerFingerprint(postData) {
        if (!postData) return null;
        const fingerprint = this.buildFingerprint({
          authorName: postData.author?.name,
          groupName: postData.to?.name,
          message: postData.message,
        });
        if (!fingerprint) return null;
        postData.matchFingerprint = fingerprint;
        const bucket = this.fingerprintIndex.get(fingerprint) || new Set();
        const key = postData.post_id || postData.id;
        if (key) {
          bucket.add(String(key));
          this.fingerprintIndex.set(fingerprint, bucket);
        }
        return fingerprint;
      }

      matchGraphQLByFingerprint(fingerprint) {
        if (!fingerprint) return null;
        const bucket = this.fingerprintIndex.get(fingerprint);
        if (!bucket) return null;
        for (const postId of bucket) {
          const candidate = this.graphqlPostsMap.get(postId);
          if (candidate && !candidate.inDOM) {
            return candidate;
          }
        }
        return null;
      }

      matchGraphQLByMessagePrefix(domMetadata) {
        let domMessage = this.normalizeStringForFingerprint(
          domMetadata?.message
        );
        if (!domMessage || domMessage.length < 5) return null;

        // Clean common suffixes that might be in DOM but not in GraphQL
        const seeMoreSuffixes = ["see more", "voir plus", "plus", "read more", "afficher la suite"];
        for (const suffix of seeMoreSuffixes) {
          if (domMessage.endsWith(suffix)) {
            domMessage = domMessage.slice(0, -suffix.length).trim();
          }
        }

        if (domMessage.length < 5) return null;

        const domAuthor = this.normalizeStringForFingerprint(
          domMetadata?.authorName
        );
        const domGroup = this.normalizeStringForFingerprint(
          domMetadata?.groupName
        );

        // Use a safe prefix for matching long messages
        const matchPrefix = domMessage.length > 60 ? domMessage.slice(0, 60) : domMessage;

        for (const candidate of this.graphqlPostsMap.values()) {
          if (!candidate || candidate.inDOM) continue;

          const candidateMessage = this.normalizeStringForFingerprint(
            candidate.message
          );
          if (!candidateMessage) continue;

          // Check if GraphQL message contains the DOM prefix
          const isMessageMatch = candidateMessage.includes(matchPrefix);

          if (!isMessageMatch) continue;

          // Verify author/group if possible (fuzzy)
          if (domAuthor) {
            const candAuthor = this.normalizeStringForFingerprint(candidate.author?.name);
            if (candAuthor && candAuthor !== domAuthor && !candAuthor.includes(domAuthor) && !domAuthor.includes(candAuthor)) {
              continue;
            }
          }

          if (domGroup) {
            const candGroup = this.normalizeStringForFingerprint(candidate.to?.name);
            if (candGroup && candGroup !== domGroup && !candGroup.includes(domGroup) && !domGroup.includes(candGroup)) {
              continue;
            }
          }

          return candidate;
        }

        return null;
      }

      sanitizeUrl(urlStr, maxLen = 250) {
        if (!urlStr || typeof urlStr !== 'string') return urlStr;
        try {
          if (urlStr.includes("data:image")) return urlStr.slice(0, maxLen);
          const url = new URL(urlStr);
          const params = new URLSearchParams(url.search);

          // Remove common tracking/junk parameters
          const junk = ["fbclid", "__cft__", "__tn__", "_rdr", "ref", "hc_ref", "extid", "refid", "refsrc", "__xts__", "_ft_", "paipv"];
          junk.forEach(p => params.delete(p));

          const search = params.toString();
          let finalUrl = url.origin + url.pathname + (search ? "?" + search : "");

          if (finalUrl.length > maxLen) {
            finalUrl = finalUrl.slice(0, maxLen);
          }
          return finalUrl;
        } catch (e) {
          return urlStr.slice(0, maxLen);
        }
      }

      extractDomMetadata(element) {
        if (!element) return null;
        const author = this.extractAuthorMetadataFromElement(element);
        const metadata = {
          postId: this.extractPostIdFromElement(element),
          postUrl: this.sanitizeUrl(this.extractPostUrlFromElement(element)),
          author: author,
          authorName: author?.name || null,
          groupName: this.extractGroupNameFromElement(element),
          message: this.extractPostMessageFromElement(element),
          images: this.extractImagesFromElement(element),
          landingPages: (this.extractLandingPagesFromElement(element) || []).map(u => this.sanitizeUrl(u)),
          attachments: [],
          cta: this.dataExtractor.extractCTA(element),
          adInfo: this.dataExtractor.extractAdInfo(element),
          advertiserName: this.dataExtractor.extractAdvertiserName(element),
          isSponsored: this.postDetector?.isSponsored(element) || this.dataExtractor.detectSponsored(element),
        };
        return metadata;
      }

      extractPostIdFromElement(element) {
        try {
          if (!element) return null;

          // Strategy A: Find purely numeric IDs first (Best for DB)
          const findNumeric = (el) => {
            const val = el.getAttribute("data-post-id") || el.getAttribute("data-feed-item-id") || el.getAttribute("data-story-id");
            if (val && /^\d+$/.test(val)) return val;
            return null;
          };

          let id = findNumeric(element);
          if (!id) {
            const candidate = element.querySelector("[data-post-id], [data-feed-item-id], [data-story-id]");
            if (candidate) id = findNumeric(candidate);
          }

          // Strategy B: Scan innerHTML for purely numeric signatures
          if (!id) {
            const html = element.innerHTML;
            const match = html.match(/"fbid"\s*:\s*"(\d+)"/) ||
              html.match(/"post_id"\s*:\s*"(\d+)"/) ||
              html.match(/"top_level_post_id"\s*:\s*"(\d+)"/);
            if (match?.[1]) id = match[1];
          }

          // Strategy C: Alphanumeric IDs (pfbid...) - convert to numeric if needed
          if (!id) {
            const links = element.querySelectorAll('a[href*="/posts/"], a[href*="/photos/"], a[href*="/videos/"], a[href*="permalink"], a[href*="story_fbid"]');
            for (const link of links) {
              const href = link.href;

              // 1. Try standard /posts/ID format
              let match = href.match(/\/(posts|photos|videos)\/([a-zA-Z0-9]+)/);
              let alphaId = (match?.[2] && match[2] !== "permalink") ? match[2] : null;

              // 2. Try story_fbid=ID parameter (common in permalink.php)
              if (!alphaId) {
                try {
                  const urlObj = new URL(href);
                  alphaId = urlObj.searchParams.get("story_fbid") || urlObj.searchParams.get("fbid");
                } catch (e) { }
              }

              if (alphaId) {
                // Standardize ID: if purely numeric, use it. If alphanumeric (pfbid), use it as is.
                if (/^\d+$/.test(alphaId)) {
                  id = alphaId;
                  break;
                } else if (alphaId.startsWith("pfbid") || alphaId.length > 10) {
                  id = alphaId;
                  break;
                }
              }
            }
          }

          // Final Check: If ID is alphanumeric, convert to numeric for the backend
          if (id && !/^\d+$/.test(id)) {
            // Generate a stable 98-prefix ID by hashing the alphanumeric identifier (pfbid)
            id = `98${this.hashCode(id).toString().padStart(13, '0')}`.slice(0, 15);
          }

          return id;
        } catch (e) {
          console.error("[CMN] Error extracting post ID:", e);
        }

        return null;
      }

      extractPostUrlFromElement(element) {
        // 1. Look for the timestamp link - often the most reliable way to get the post URL in Comet
        const timestampLink = element.querySelector('a[href*="/posts/"], a[href*="/permalink.php"], a[href*="/permalink/"], a[href*="/videos/"], a[href*="/photo.php"], a[href*="/photo/"], a[href*="/reel/"], a[href*="/story/"], a[href*="pfbid"], a[href*="/groups/"][href*="/posts/"], a[href*="view=permalink"], a[href*="/permalink?"]');
        if (timestampLink) {
          try {
            const urlStr = timestampLink.href;
            if (urlStr.includes("facebook.com/l.php?u=")) {
              // Decode outbound links if needed
              const url = new URL(urlStr);
              const target = url.searchParams.get("u");
              if (target) return target;
            }
            const url = new URL(urlStr);
            const params = new URLSearchParams();
            ["story_fbid", "id", "fbid", "set", "post_id"].forEach(p => {
              if (url.searchParams.has(p)) params.set(p, url.searchParams.get(p));
            });
            const search = params.toString();
            return url.origin + url.pathname + (search ? "?" + search : "");
          } catch (e) { }
        }

        // 3. Fallback: scan all links for anything that looks like a post
        const allLinks = element.querySelectorAll('a[href]');
        for (const link of allLinks) {
          const href = link.href;
          if (href.includes("/posts/") || href.includes("/permalink") || href.includes("story_fbid") || href.includes("pfbid")) {
            return href.split("?")[0];
          }
        }

        return "";
      }

      extractAuthorMetadataFromElement(element) {
        if (!element) return null;
        const author = {
          name: this.extractProfileNameFromElement(element),
          url: null,
          id: null,
          profile_picture: null
        };

        // Try to find the profile picture link/image
        const profilePic = element.querySelector('a[role="link"] img, a[role="link"] svg image');
        if (profilePic) {
          author.profile_picture = this.sanitizeUrl(profilePic.src || profilePic.getAttribute("xlink:href"));
          const picLink = profilePic.closest('a[href]');
          if (picLink && !author.url) {
            author.url = this.sanitizeUrl(picLink.href);
          }
        }

        const links = Array.from(element.querySelectorAll('a[href]'));

        for (const link of links) {
          const href = link.href;
          if (href.includes("/posts/") || href.includes("/groups/") || href.includes("/videos/") ||
            href.includes("/permalink/") || href.includes("/sharer/") || href.includes("/ads/")) continue;

          const text = link.textContent.trim();
          const ariaLabel = link.getAttribute("aria-label") || "";

          const isLikelyAuthor = (author.name && author.name !== "Unknown Author" && (text.includes(author.name) || ariaLabel.includes(author.name))) ||
            href.includes("profile.php") ||
            link.hasAttribute("data-hovercard") ||
            link.closest('h2, h3, h4');

          if (isLikelyAuthor) {
            try {
              const url = new URL(href);
              if (url.pathname === "/profile.php") {
                const id = url.searchParams.get("id");
                if (id) {
                  author.id = this.ensureNumericId(id);
                  author.url = `${url.origin}/profile.php?id=${id}`;
                }
              } else if (url.pathname.includes("/stories/")) {
                const parts = url.pathname.split("/").filter(Boolean);
                if (parts[1] && /^\d+$/.test(parts[1])) {
                  author.id = this.ensureNumericId(parts[1]);
                  author.url = `${url.origin}/profile.php?id=${parts[1]}`;
                } else {
                  author.url = url.origin + url.pathname;
                }
              } else {
                author.url = url.origin + url.pathname;
                author.id = this.ensureNumericId(this.extractIdFromUrl(href));
              }

              if (author.url) author.url = this.sanitizeUrl(author.url);
              if (!author.name || author.name === "Unknown Author") {
                author.name = text || ariaLabel || (author.id ? this.idToAuthorNameCache.get(author.id) : null) || "Unknown Author";
              }
              if (author.id && author.name && author.name !== "Unknown Author") {
                this.idToAuthorNameCache.set(author.id, author.name);
              }
              break;
            } catch (e) {
              author.url = this.sanitizeUrl(href.split("?")[0]);
              author.id = this.extractIdFromUrl(href);
              break;
            }
          }
        }

        // Final fallback for ID/URL if name is known but no URL found
        if (author.name && author.name !== "Unknown Author" && !author.id) {
          const nameLink = Array.from(element.querySelectorAll('a[href]')).find(l => l.textContent.includes(author.name));
          if (nameLink) {
            author.url = this.sanitizeUrl(nameLink.href);
            author.id = this.ensureNumericId(this.extractIdFromUrl(nameLink.href));
          }
        }

        return author;
      }

      extractProfileNameFromElement(element) {
        let name = null;
        const headings = element.querySelectorAll('h2, h3, h4');
        for (const h of headings) {
          const links = h.querySelectorAll('a[role="link"]');
          for (const link of links) {
            const text = link.textContent.trim();
            if (text && text.length > 1 && !/^\d+/.test(text)) {
              name = text;
              break;
            }
          }
          if (name) break;
        }

        if (!name || name === "Unknown Author") {
          const cometName = element.querySelector('a[role="link"] span.x193iq5w, a[role="link"] span.x1lliihq');
          if (cometName) name = cometName.textContent.trim();
        }

        if (name) {
          const separators = [" · ", " • ", " - "];
          for (const sep of separators) {
            if (name.includes(sep)) name = name.split(sep)[0];
          }
          name = name.replace(/(Follow|Suivre|Sponsorisé|Sponsored|Publicité|Ad)$/i, "").trim();
        }

        return name || "Unknown Author";
      }

      extractGroupNameFromElement(element) {
        const groupEl = element.querySelector(
          'a[href*="/groups/"] span, [data-ad-rendering-role="story_to"] span'
        );
        return groupEl?.textContent?.trim() || null;
      }

      extractPostMessageFromElement(element) {
        // Walk the DOM tree collecting text nodes while SKIPPING role="button" elements.
        // This prevents "See more" / "Voir plus" button text from being mixed into the message.
        const getCleanText = (el) => {
          if (!el) return "";
          let out = "";
          for (const node of el.childNodes) {
            if (node.nodeType === Node.TEXT_NODE) {
              out += node.textContent;
            } else if (node.nodeType === Node.ELEMENT_NODE) {
              if (node.getAttribute?.("role") === "button") continue; // skip action buttons
              out += getCleanText(node);
            }
          }
          return out;
        };

        // 1. Preferred: known Facebook message containers
        let messageEl =
          element.querySelector(
            '[data-ad-rendering-role="story_message"], [data-ad-preview="message"], [data-ad-comet-preview="message"]'
          ) || element.querySelector('[data-testid="post_message"]');

        let text = messageEl ? getCleanText(messageEl).trim() : null;

        // 2. Broad fallback: first meaningful dir="auto" div that isn't a heading/link
        if (!text) {
          const divs = Array.from(element.querySelectorAll('div[dir="auto"]'));
          for (const div of divs) {
            if (div.closest('h2, h3, h4, [role="link"]')) continue;
            const content = getCleanText(div).trim();
            if (content.length > 20) { text = content; break; }
          }
        }

        // 3. Auto-expand: try to click "See more" / "Voir plus" / "Voir la suite"
        try {
          const container = messageEl || element;
          const allButtons = Array.from(container.querySelectorAll('[role="button"]'));
          for (const btn of allButtons) {
            const btnText = btn.textContent?.trim().toLowerCase() || "";
            if (
              (btnText === "see more" || btnText === "voir plus" ||
              btnText === "voir la suite" || /^voir\b/.test(btnText)) &&
              !btnText.includes("less") && !btnText.includes("moins") &&
              !btn.hasAttribute("data-cmn-clicked")
            ) {
              btn.setAttribute("data-cmn-clicked", "true");
              btn.click();
              // Re-read text immediately (synchronous in many React builds)
              const expanded = getCleanText(container).trim();
              if (expanded && expanded.length > (text?.length || 0)) {
                text = expanded;
              }
              break;
            }
          }
        } catch (_) { }

        // 4. Final cleanup: strip any residual "See more" / "Voir plus" suffixes
        if (text) {
          const suffixes = [
            "… See more", "... See more",
            "… Voir plus", "... Voir plus",
            "…Voir plus", "…See more",
            "… Voir la suite", "… عرض المزيد",
            "See more", "Voir plus",
          ];
          for (const s of suffixes) {
            if (text.endsWith(s)) {
              text = text.slice(0, -s.length).trim();
              break;
            }
          }
        }

        return text || null;
      }

      extractImagesFromElement(element) {
        const images = [];
        const imgEls = Array.from(element.querySelectorAll("img[src]"));
        for (const img of imgEls) {
          const src = img.getAttribute("src");
          if (!src || src.includes("/rsrc.php/") || src.includes("emoji.php") || src.includes("static.xx.fbcdn.net") || src.length < 50) continue;
          images.push(src);
        }
        return [...new Set(images)].slice(0, 10);
      }

      extractLandingPagesFromElement(element) {
        const links = new Set();
        const anchors = element.querySelectorAll('a[href*="l.facebook.com/l.php"]');
        anchors.forEach((a) => {
          try {
            const url = new URL(a.href);
            const target = url.searchParams.get("u");
            if (target) links.add(target);
          } catch (e) { }
        });
        return Array.from(links);
      }

      isPublicPostElement(element) {
        if (!element) return false;
        const publicIcons = element.querySelectorAll('[aria-label*="Public"], [aria-label*="Publico"], [aria-label*="Shared with Public"], [title*="Public"]');
        if (publicIcons.length > 0) return true;

        const svgs = element.querySelectorAll("svg");
        for (const svg of svgs) {
          const w = parseInt(svg.getAttribute("width") || "0", 10);
          const h = parseInt(svg.getAttribute("height") || "0", 10);
          if (w > 20 || h > 20) continue;
          const paths = svg.querySelectorAll("path");
          const uses = svg.querySelectorAll("use");
          if (paths.length >= 2 || uses.length > 0) return true;
        }
        return false;
      }

      buildRegisterAdPayload(postData) {
        if (!postData) return null;
        const isSponsored = Boolean(postData.ad?.ad_id || postData.isSponsored);
        const isNewsPost = this.newsFilter?.isNewsPost ? this.newsFilter.isNewsPost(postData) : false;

        const postType = isSponsored ? "frontAd" : isNewsPost ? "newsPost" : "publicPost";
        const postIdentifier = postData.post_id || postData.id;
        const htmlId = isSponsored ? (postData.ad?.ad_id || postIdentifier) : postIdentifier;

        const rawAuthor = postData.author ? { ...postData.author } : { name: "Unknown Author" };
        if (rawAuthor.profile_picture) rawAuthor.profile_picture = this.sanitizeUrl(rawAuthor.profile_picture);
        if (rawAuthor.url) rawAuthor.url = this.sanitizeUrl(rawAuthor.url);

        const rawAttachments = (postData.attachments || []).map(att => {
          if (!att) return att;
          const a = { ...att };
          if (a.image) {
            a.image = { ...a.image };
            if (a.image.flexible) a.image.flexible = this.sanitizeUrl(a.image.flexible);
            if (a.image.large) a.image.large = this.sanitizeUrl(a.image.large);
          }
          return a;
        });

        const rawAdObject = {
          post_id: postIdentifier,
          id: postData.id,
          message: postData.message || "",
          url: this.sanitizeUrl(postData.url || ""),
          author: rawAuthor,
          attachments: rawAttachments,
          ad: postData.ad || null,
          cta: postData.cta || null,
          ad_info: postData.adInfo || null,
          ad_disclaimer: postData.advertiserName || null,
        };

        const rawAdString = JSON.stringify(rawAdObject);
        if (!rawAdString || rawAdString === "{}") {
          console.error("[CMN] CRITICAL: buildRegisterAdPayload generated empty raw_ad!", postData);
        }

        return {
          type: postType,
          fb_id: postIdentifier,
          html_ad_id: htmlId,
          adanalyst_ad_id: htmlId,
          objId: postIdentifier,
          timestamp: Date.now(),
          visible: true,
          visible_fraction: 1,
          visibleDuration: postData.visibleDuration || [],
          offsetX: 0,
          offsetY: 0,
          landing_pages: (postData.landingPages || []).map(u => this.sanitizeUrl(u)),
          images: (postData.images || []).map(u => typeof u === 'string' ? this.sanitizeUrl(u) : u),
          attachment_media_urls: (postData.attachments || []).map(a => a.url).filter(Boolean),
          raw_ad: rawAdString,
          advertiser_facebook_id: this.ensureNumericId(postData.author?.id),
          advertiser_facebook_page: this.sanitizeUrl(postData.author?.url) || null,
          advertiser_facebook_profile_pic: this.sanitizeUrl(postData.author?.profile_picture || postData.author?.profilePic) || null,
          cta: postData.cta || null,
          ad_info: postData.adInfo ? JSON.stringify(postData.adInfo) : null,
          ad_disclaimer: postData.advertiserName || null,
          landing_domain: this.extractDomain(postData.landingPages?.[0] || postData.url) || null,
        };
      }

      hashCode(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
          hash = (hash << 5) - hash + str.charCodeAt(i);
          hash |= 0;
        }
        return Math.abs(hash);
      }

      ensureNumericId(id) {
        if (!id) return null;
        const idStr = String(id);
        if (/^\d+$/.test(idStr)) return idStr;
        // If alphanumeric (vanity ID), hash it and use a 97 prefix to distinguish from 98/99 prefixes
        return `97${this.hashCode(idStr).toString().padStart(12, '0')}`.slice(0, 15);
      }

      hashString(input) {
        return this.hashCode(input).toString(36);
      }

      extractDomain(url) {
        if (!url || typeof url !== 'string') return null;
        try {
          const u = new URL(url);
          return u.hostname.replace(/^www\./, '');
        } catch (e) {
          return null;
        }
      }

      preparePostForQueue(postData) {
        const sanitized = { ...postData };
        sanitized.messagePreview = postData.message?.slice(0, 120) || null;
        sanitized.messageHash = this.hashString(postData.message || "");
        return sanitized;
      }

      isPrivatePost(postData) {
        const desc = postData?.privacy?.description || postData?.privacy_description || "";
        return desc.toLowerCase().includes("private");
      }

      async queuePostForSending(postData) {
        if (!postData || (postData.queued && !postData._forceQueue)) return false;
        if (this.isPrivatePost(postData)) return false;

        const hasUrl = typeof postData.url === "string" && postData.url.length > 10;
        const hasImages = Array.isArray(postData.images) && postData.images.length > 0;
        const hasMessage = postData.message?.trim().length > 5;
        const isNews = this.newsFilter?.isNewsPost ? this.newsFilter.isNewsPost(postData) : false;
        const isSponsored = postData.isSponsored || false;
        const isPrivate = this.isPrivatePost(postData);
        
        // Strategy: Collect if it's an Ad, News, OR if it's NOT private and has some content
        const shouldCollect = isSponsored || isNews || (!isPrivate && (hasMessage || hasImages));

        if (!shouldCollect) {
          console.warn("[CMN] Post skipped: criteria not met", { 
            id: postData.id, 
            isSponsored, 
            isNews, 
            isPrivate, 
            hasMessage, 
            hasImages,
            message: postData.message?.substring(0, 30)
          });
          return false;
        }

        if (!hasUrl && !hasImages && !hasMessage) {
          console.warn("[CMN] Post skipped: NO CONTENT (URL, images, message)", postData.id);
          return false;
        }

        postData.queued = true;
        postData.register_ad_payload = this.buildRegisterAdPayload(postData);
        const prepared = this.preparePostForQueue(postData);
        console.log("[CMN] >>> QUEUEING POST:", prepared.id, prepared.message?.substring(0, 50));
        
        const added = await this.storageManager.addPost(prepared);
        if (added) {
          console.log(`%c [CMN-Success] Post SAVED to queue: ${prepared.id}`, "color: white; background: green; font-weight: bold;");
        } else {
          console.log(`[CMN] Post updated/already in queue: ${prepared.id}`);
        }
        return true; // Return true if we successfully "handled" it (even if it was an update)
      }

      log(...args) {
        if (this.config.debugMode || localStorage.getItem("CMN_DEBUG") === "1") {
          console.log("[CMN]", ...args);
        }
      }

      async init() {
        console.log("[CMN] Initializing CheckMyNewsMain...");
        if (this.initialized) return;

        try {
          await this.loadConfig();
          console.log("[CMN] Config loaded:", this.config);

          if (!this.config.enabled) {
            console.warn("[CMN] Extension disabled, force-enabling for debug.");
            this.config.enabled = true;
          }

          console.log("[CMN] Initializing components...");
          this.messageHandler = new FBMessageHandler();
          this.postDetector = new FBPostDetector();
          this.dataExtractor = new FBDataExtractor();
          this.newsFilter = new FBNewsFilter();
          this.storageManager = new FBStorageManager();
          console.log("[CMN] Storage manager init...");
          await this.storageManager.init();

          this.visibilityTracker = new FBVisibilityTracker((ids) => this.handlePostsVisible(ids));
          this.visibilityTracker.start();

          this.bootstrapBridge = new FBBootstrapBridge((post) => {
            const postData = { ...post, source: "bootstrap", inDOM: false };
            const id = post.post_id || post.id;
            if (id && !this.postDetector.isProcessed(id)) {
              this.graphqlPostsMap.set(String(id), postData);
              this.registerFingerprint(postData);
              // Post is indexed but NOT queued until visible
            }
          });
          this.bootstrapBridge.start();

          this.observer = new FBObserver(
            (el) => this.handleDOMPost(el),
            (id) => this.handlePostRemoved(id)
          );

          this.setupGraphQLBridge();
          this.setupEventHandlers();
          this.start();
          this.initialized = true;
          // console.log("%c [CMN] SUCCESS: Initialization complete. Observer is running.", "color: green; font-weight: bold; font-size: 14px;");
        } catch (e) {
          console.error("[CMN] Initialization error:", e);
        }
      }

      setupGraphQLBridge() {
        window.addEventListener("CMN_POSTS_EXTRACTED", (e) => {
          (e.detail?.posts || []).forEach(p => this.handleGraphQLPost(p));
        });
        window.addEventListener("message", (e) => {
          if (e.data?.source === "CMN_PAGE" && e.data?.type === "CMN_GRAPHQL_POSTS") {
            (e.data.posts || []).forEach(p => this.handleGraphQLPost(p));
          }
        });
      }

      async handleGraphQLPost(post) {
        this.stats.graphqlPostsReceived++;
        const postId = post.post_id || post.id;
        if (!postId) return;

        if (this.postDetector.isProcessedGraphQL?.(postId)) return;
        this.postDetector.markAsProcessedGraphQL?.(postId);

        // ✅ Normalize GraphQL alphanumeric IDs to 98-prefix immediately for consistency
        let finalPostId = postId;
        if (finalPostId && !/^\d+$/.test(finalPostId)) {
          finalPostId = `98${this.hashCode(finalPostId).toString().padStart(13, '0')}`.slice(0, 15);
        }

        const postData = {
          ...post,
          id: finalPostId,
          post_id: finalPostId,
          original_graphql_id: postId,
          source: "graphql",
          detectedAt: Date.now(),
          inDOM: false
        };
        if (postData.url) postData.url = this.sanitizeUrl(postData.url);
        if (postData.landing_pages) postData.landingPages = postData.landing_pages.map(u => this.sanitizeUrl(u));
        if (postData.images) postData.images = postData.images.map(u => typeof u === 'string' ? this.sanitizeUrl(u) : u);
        if (postData.author?.profile_picture) postData.author.profile_picture = this.sanitizeUrl(postData.author.profile_picture);

        this.graphqlPostsMap.set(String(postId), postData);
        this.registerFingerprint(postData);
        console.log(`[CMN] GraphQL post indexed: ${postId}. Waiting for it to appear in DOM/Viewport.`);
      }

      async handleDOMPost(postElement) {
        if (!this.initialized) return;
        console.log("[CMN] handleDOMPost: Start processing new DOM element", postElement);

        try {
          this.stats.postsDetected++;
          console.log("[CMN] handleDOMPost: Processing element", postElement);

          // ── STEP 0: Synchronous early dedup ──────────────────────────────────
          const earlyMeta = this.extractDomMetadata(postElement);
          const earlyFingerprint = this.buildFingerprint(earlyMeta);
          const earlyId = earlyMeta.postId || earlyFingerprint;

          if (!earlyMeta.message && !earlyMeta.postId) return;

          // If already fully processed, bail out now
          if (earlyId && this.postDetector.isProcessed(earlyId)) return;

          // Acquire a per-fingerprint mutex to prevent parallel duplicates.
          const lockKey = earlyFingerprint || earlyId;
          if (lockKey) {
            if (this.processingFingerprints.has(lockKey)) {
              return;
            }
            this.processingFingerprints.add(lockKey);
          }

          // ── STEP 1: Async retry loop to find a GraphQL match ─────────────────
          const maxRetries = 5;
          let gqlPost = null;
          let domMetadata = earlyMeta;
          let matchedPostId = null;

          try {
            for (let attempt = 0; attempt < maxRetries; attempt++) {
              domMetadata = this.extractDomMetadata(postElement);
              const domPostId = domMetadata.postId;
              const domFingerprint = this.buildFingerprint(domMetadata);

              if (!domMetadata.message && !domPostId) {
                console.log(`[CMN] handleDOMPost: Attempt ${attempt + 1}/${maxRetries} - Still waiting for content...`);
                if (attempt < maxRetries - 1) {
                  await new Promise(r => setTimeout(r, 600));
                  continue;
                }
                return;
              }

              const dedupeId = domPostId || domFingerprint;
              if (!dedupeId) continue;

              // Standard deduplication: skip if already handled in DOM
              if (this.postDetector.isProcessed(dedupeId)) {
                const existingGql = (domPostId && this.graphqlPostsMap.get(domPostId)) ||
                  this.matchGraphQLByFingerprint(domFingerprint);

                if (!existingGql || existingGql.inDOM) {
                  return;
                }
              }

              gqlPost = (domPostId && this.graphqlPostsMap.get(domPostId)) ||
                this.matchGraphQLByFingerprint(domFingerprint);

              if (gqlPost) {
                matchedPostId = gqlPost.post_id || gqlPost.id;
                break;
              }

              if (attempt < maxRetries - 1) {
                await new Promise(r => setTimeout(r, 600));
              }
            }

            if (gqlPost && matchedPostId) {
              console.log(`[CMN] handleDOMPost: Matched with GQL post ${matchedPostId}`);
                // Enrich and mark as in DOM
                gqlPost.inDOM = true;
                gqlPost.domFoundAt = Date.now();
                if (!gqlPost.message && domMetadata.message) gqlPost.message = domMetadata.message;
                if (!gqlPost.url && domMetadata.postUrl) gqlPost.url = domMetadata.postUrl;
                if (!gqlPost.author?.name && domMetadata.authorName) {
                   gqlPost.author = gqlPost.author || {};
                   gqlPost.author.name = domMetadata.authorName;
                }

                this.postDetector.markAsProcessed(matchedPostId);
                this.domElementByPostId.set(String(matchedPostId), postElement);

                console.log(`[CMN] handleDOMPost: Post ${matchedPostId} linked to DOM. Tracking visibility...`);
              if (this.visibilityTracker) this.visibilityTracker.track(postElement, matchedPostId);
            } else {
              // NO GraphQL match after retries: Create a standalone DOM post
              const domFingerprint = this.buildFingerprint(domMetadata);
              const hashSource = domMetadata.postId || domMetadata.postUrl || domFingerprint || domMetadata.message || "unknown";
              const finalId = domMetadata.postId || `99${this.hashCode(hashSource).toString().padStart(13, '0')}`.slice(0, 15);

              if (this.postDetector.isProcessed(finalId)) return;
              
              console.log(`[CMN] handleDOMPost: Found standalone post ${finalId}`, { domMetadata });

              const syntheticPost = {
                id: finalId,
                post_id: finalId,
                message: domMetadata.message,
                matchFingerprint: domFingerprint,
                url: domMetadata.postUrl || window.location.href.split("?")[0],
                author: domMetadata.author || { name: domMetadata.authorName || "Unknown Author" },
                attachments: [],
                ad: domMetadata.isSponsored ? { ad_id: finalId } : null,
                source: "dom_standalone",
                inDOM: true,
                domFoundAt: Date.now(),
                isSponsored: this.postDetector.isSponsored(postElement),
                detectedAt: Date.now(),
                images: domMetadata.images || [],
                landingPages: domMetadata.landingPages || [],
              };

              this.postDetector.markAsProcessed(finalId);
              if (domFingerprint) this.postDetector.markAsProcessed(domFingerprint);
              this.graphqlPostsMap.set(String(finalId), syntheticPost);
              this.domElementByPostId.set(String(finalId), postElement);
              console.log(`[CMN] handleDOMPost: Standalone post ${finalId} created. Tracking visibility...`);
              if (this.visibilityTracker) {
                this.visibilityTracker.track(postElement, finalId);
              }
            }
          } finally {
            if (lockKey) this.processingFingerprints.delete(lockKey);
          }
        } catch (error) {
          console.error("[CMN] Error in handleDOMPost:", error);
        }
      }

      handlePostRemoved(id) {
        console.log(`[CMN] handlePostRemoved: ${id}`);
        if (id) this.domElementByPostId.delete(String(id));
      }

      handlePostsVisible(ids) {
        try {
          if (!ids || !Array.isArray(ids)) return;
          ids.forEach(id => {
            const post = this.graphqlPostsMap.get(String(id));
            if (post && !post.visibleAt) {
              // console.log(`%c [CMN] handlePostsVisible: ${id} - NOW VISIBLE`, "color: green; font-weight: bold;");
              post.visibleAt = Date.now();
              this.queuePostForSending(post);
            }
          });
        } catch (e) {
          console.error("[CMN] Error in handlePostsVisible:", e);
        }
      }

      async loadConfig() {
        const res = await chrome.storage.local.get(["cmn_config"]);
        if (res.cmn_config) this.config = { ...this.config, ...res.cmn_config };
      }

      setupEventHandlers() {
        this.messageHandler?.on("stats-requested", ({ sendResponse }) => sendResponse({ isInitialized: this.initialized }));
      }

      start() {
        this.monitoring = true;
        this.visibilityTracker?.start();
        this.observer?.start();
      }

      stop() {
        this.monitoring = false;
        this.observer?.stop();
        this.visibilityTracker?.stop();
      }

      extractIdFromUrl(url) {
        if (!url) return null;
        try {
          const u = new URL(url);
          return u.searchParams.get("id") || u.pathname.split("/").filter(Boolean).pop();
        } catch { return null; }
      }
    }

    const main = new CheckMyNewsMain();
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => main.init());
    } else {
      main.init();
    }
    window.CMN = main;
  } catch (err) {
    console.error("[CMN] Fatal Error in fbMain.js:", err);
  }
})();
