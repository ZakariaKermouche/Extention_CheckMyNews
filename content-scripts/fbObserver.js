// content-scripts/fbObserver.js
function isPublicPost(post) {
  const svgs = post.querySelectorAll("svg");

  for (const svg of svgs) {
    const w = parseInt(svg.getAttribute("width") || "0", 10);
    const h = parseInt(svg.getAttribute("height") || "0", 10);

    if (w > 20 || h > 20) continue;
    if (svg.closest("a")) continue;

    const paths = svg.querySelectorAll("path");
    if (paths.length >= 3) {
      return true; // 🌍 public
    }
  }

  return false;
}

class FBObserver {
  constructor(onPostFound, onPostRemoved) {
    this.observer = null;
    this.onPostFound = onPostFound;
    this.onPostRemoved = onPostRemoved;
    this.feedContainer = null;
    this.isObserving = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.initialScanDelayMs = 1500;
    this.safetyScanInterval = null;
    this.safetyScanMs = 3000; // Scan every 3s as safety
  }

  // Find the main feed container
  findFeedContainer() {
    console.log("[CMN] Observer: Searching for feed container...");
    const selectors = [
      '[data-pagelet="ProfileTimeline"]',
      '[data-pagelet="ProfileCometTimelineFeed"]',
      '[role="feed"]',
      '[role="main"]',
      '[id^="topnews_main_stream"]',
      '#ssrb_feed_start + div',
      'div[data-pagelet="FeedUnit_0"]',
      '#mainContainer'
    ];

    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el) {
        console.log(`[CMN] Observer: Found feed container via "${selector}"`);
        return el;
      }
    }

    return document.body;
  }

  // Start observing the feed
  start() {
    if (this.isObserving) {
      return;
    }

    this.feedContainer = this.findFeedContainer();

    if (!this.feedContainer) {
      this.scheduleReconnect();
      return;
    }

    // Setup mutation observer
    this.observer = new MutationObserver((mutations) => {
      this.handleMutations(mutations);
    });

    this.observer.observe(this.feedContainer, {
      childList: true,
      subtree: true,
    });

    this.isObserving = true;
    this.reconnectAttempts = 0;

    this.initialScanTimer = setTimeout(() => {
      // Only run if still observing.
      if (this.isObserving) {
        console.log("[CMN] Running initial scan...");
        this.processExistingPosts();
      }
      this.initialScanTimer = null;
    }, this.initialScanDelayMs);

    // Safety scan interval
    this.safetyScanInterval = setInterval(() => {
      if (this.isObserving) {
        this.processExistingPosts();
      }
    }, this.safetyScanMs);
  }

  // Stop observing
  stop() {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    if (this.initialScanTimer) {
      clearTimeout(this.initialScanTimer);
      this.initialScanTimer = null;
    }
    if (this.safetyScanInterval) {
      clearInterval(this.safetyScanInterval);
      this.safetyScanInterval = null;
    }
    this.isObserving = false;
  }

  // Process existing posts in feed
  processExistingPosts() {
    // Re-find container in case it changed (Comet often replaces feed root during navigation)
    // NOTE: This is critical for SPA support (e.g., Home -> Profile navigation)
    const currentContainer = this.findFeedContainer();
    
    if (currentContainer && currentContainer !== this.feedContainer) {
      // console.log("[CMN] Observer: Feed container changed/replaced. Re-observing new container.");
      this.feedContainer = currentContainer;
      if (this.observer) {
        try {
          this.observer.disconnect();
          this.observer.observe(this.feedContainer, {
            childList: true,
            subtree: true,
          });
        } catch (e) {
          console.error("[CMN] Observer: Failed to re-observe container:", e);
        }
      }
    }

    if (!this.feedContainer) return;

    const existingPosts = this.findAllPostElements(this.feedContainer);
    
    /* if (existingPosts.length > 0) {
      console.log(`[CMN] Observer: Safety scan found ${existingPosts.length} posts`);
    } */

    existingPosts.forEach((post) => {
      if (this.onPostFound) {
        this.onPostFound(post);
      }
    });
  }

  // Handle mutation events
  handleMutations(mutations) {
    const processedNodes = new Set();
    let totalFound = 0;

    mutations.forEach((mutation) => {
      // Handle added nodes
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        if (processedNodes.has(node)) return;

        processedNodes.add(node);

        const found = new Set();

        // Check if node itself is a post
        if (this.isPostElement(node)) {
          found.add(node);
        }

        // Check for posts within the node
        const posts = this.findAllPostElements(node);
        posts.forEach((post) => found.add(post));

        totalFound += found.size;

        found.forEach((post) => {
          if (processedNodes.has(post)) return;
          processedNodes.add(post);
          if (this.onPostFound) {
            this.onPostFound(post);
          }
        });
      });

      // Handle removed nodes (optional)
      mutation.removedNodes.forEach((node) => {
        if (node.nodeType !== Node.ELEMENT_NODE) return;

        if (this.isPostElement(node) && this.onPostRemoved) {
          this.onPostRemoved(node);
        }
      });
    });

    if (totalFound > 0) {
      console.log(`[CMN] Observer: Found ${totalFound} potential posts in mutations`);
    }
  }

  // Find all post elements in a container
  findAllPostElements(container) {
    // Broaden search to include role="article" which is the standard for Comet posts
    // alongside older data-ad-rendering-role markers.
    const markers = container.querySelectorAll(
      'div[role="article"], div[data-ad-rendering-role="profile_name"], [data-ad-rendering-role="story_message"], [aria-posinset], [data-testid="fb-feed-item"], [data-pagelet^="FeedUnit_"], [data-testid="post_message"], [data-ad-preview="message"], [data-ad-comet-preview="message"]'
    );

    const posts = [];

    markers.forEach((marker) => {
      // If the marker itself is a post container, use it. Otherwise find closest container.
      const post = this.isPostElement(marker)
        ? marker
        : this.findPostContainerFromMarker(marker);
      if (post && this.isValidPostElement(post)) posts.push(post);
    });

    const deduped = [...new Set(posts)];
    if (deduped.length > 0) {
      console.log(`[CMN] Observer: Found ${deduped.length} unique post elements in container`, container === document.body ? "BODY" : container);
    }
    return deduped;
  }

  // Check if element is a post
  isPostElement(element) {
    if (!element || !element.querySelector) return false;

    // Article role is the standard for almost all FB posts now.
    if (element.getAttribute("role") === "article") return true;

    // Fallback markers for other views
    const hasToolbar = !!element.querySelector(
      '[aria-label*="Actions"], [aria-label*="Actions"], [aria-haspopup="menu"]'
    );
    const hasMessage = !!element.querySelector(
      '[data-ad-rendering-role="story_message"], [data-ad-preview="message"], [data-ad-comet-preview="message"]'
    );

    const isPost = hasToolbar || hasMessage;
    // if (!isPost && element.tagName === 'DIV' && element.textContent.length > 50) {
    //   console.log("[CMN] Observer: Node rejected as post despite length:", element.textContent.substring(0, 50));
    // }
    return isPost;
  }

  // Find post container from a marker element
  findPostContainerFromMarker(marker) {
    if (!marker) return null;

    // Fast path: FB often wraps posts in virtualized container
    const virtualized = marker.closest('div[data-virtualized="false"]');
    if (virtualized && this.isPostElement(virtualized)) return virtualized;

    // Walk up to find a container with expected markers
    let current = marker;
    let depth = 0;
    const maxDepth = 12;

    while (current && current !== document.body && depth < maxDepth) {
      if (this.isPostElement(current)) return current;
      current = current.parentElement;
      depth++;
    }

    return null;
  }

  // Basic sanity check for post-like nodes
  isValidPostElement(element) {
    if (!element) return false;
    const text = element.textContent?.trim() || "";
    // Posts on FB always have some text (author name, timestamp, etc.)
    return text.length > 5;
  }

  // Schedule reconnection attempt
  scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 10000);


    setTimeout(() => {
      this.start();
    }, delay);
  }

  // Reset observer (useful for navigation)
  reset() {
    this.stop();
    this.reconnectAttempts = 0;
    setTimeout(() => this.start(), 1000);
  }

  // Get status
  getStatus() {
    return {
      isObserving: this.isObserving,
      hasFeedContainer: !!this.feedContainer,
      reconnectAttempts: this.reconnectAttempts,
    };
  }
}

// Export for use in other scripts
window.FBObserver = FBObserver;
