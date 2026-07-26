// content-scripts/fbPostDetector.js - FIXED VERSION

/**
 * FBPostDetector
 * Responsabilité : Identifie les posts dans le flux Facebook et gère leur état (traité ou non).
 * Il assure la déduplication entre les détections du DOM et les interceptions GraphQL.
 */
class FBPostDetector {
  constructor() {
    this.processedPosts = new Set();
    this.processedGraphQLPosts = new Set(); 
    this.postIdCounter = 0;
    
    // Load from session storage to survive refreshes
    try {
      const stored = sessionStorage.getItem('cmn_processed_posts');
      if (stored) {
        const list = JSON.parse(stored);
        if (Array.isArray(list)) {
          list.forEach(id => this.processedPosts.add(id));
        }
      }
    } catch (e) {}
  }

  // Check if post has already been processed (DOM element)
  isProcessed(input) {
    if (!input) return false;
    if (typeof input === 'string') return this.processedPosts.has(input);
    return input.dataset && input.dataset.cmnProcessed === "true";
  }

  // Check if GraphQL post has been processed
  isProcessedGraphQL(postId) {
    if (!postId) return false;
    return this.processedGraphQLPosts.has(postId);
  }

  // Mark post as processed (DOM element)
  markAsProcessed(input) {
    if (!input) return;
    if (typeof input === 'string') {
      this.processedPosts.add(input);
    } else {
      if (input.dataset) input.dataset.cmnProcessed = "true";
      const id = this.generatePostId(input);
      if (id) this.processedPosts.add(id);
    }
  }

  // Mark GraphQL post as processed
  markAsProcessedGraphQL(postId) {
    if (!postId) return;
    this.processedGraphQLPosts.add(postId);
  }

  // Generate unique post ID
  generatePostId(element) {
    // ✅ FIX: Handle null/undefined element
    if (!element) {
      return `post_${Date.now()}_${this.postIdCounter++}`;
    }

    // Try to get ID from element attributes
    const pageletId = element.getAttribute?.("data-pagelet");
    if (pageletId) return pageletId;

    const ariaLabel = element.getAttribute?.("aria-labelledby");
    if (ariaLabel) return ariaLabel;

    const elementId = element.getAttribute?.("id");
    if (elementId) return elementId;

    // Fallback: generate from position and content
    const textContent = element.textContent?.substring(0, 50) || "";
    const hash = this.hashCode(textContent);
    return `post_${hash}_${this.postIdCounter++}`;
  }

  // Simple hash function
  hashCode(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(36);
  }

  // Check if post is visible on screen
  isVisible(element) {
    if (!element) return false;

    const rect = element.getBoundingClientRect();
    const viewHeight =
      window.innerHeight || document.documentElement.clientHeight;

    return (
      rect.top >= 0 &&
      rect.left >= 0 &&
      rect.bottom <= viewHeight + 1000 && // Include 1000px buffer
      rect.right <= (window.innerWidth || document.documentElement.clientWidth)
    );
  }

  // Get post type
  getPostType(element) {
    if (!element) return "unknown";

    // Check for video
    if (element.querySelector?.("video")) {
      return "video";
    }

    // Check for image
    if (element.querySelector?.('img[src*="scontent"]')) {
      return "photo";
    }

    // Check for shared link
    if (element.querySelector?.('a[href*="l.facebook.com"]')) {
      return "shared_link";
    }

    // Check for live video
    if (
      element.textContent?.includes("Live") &&
      element.querySelector?.("video")
    ) {
      return "live";
    }

    return "status";
  }

  // Check if post is sponsored
  isSponsored(element) {
    if (!element) return false;

    // 1. Check for explicit data attributes
    if (
      element.hasAttribute?.("data-is-sponsored") ||
      element.querySelector?.("[data-ad-rendering-role]")
    ) {
      return true;
    }

    // 2. Check for sponsored aria-labels (common in modern FB)
    const sponsoredLabel = element.querySelector?.(
      '[aria-label*="Sponsored"], [aria-label*="Sponsorisé"], [aria-label*="Publicité"], [aria-label*="Gesponsert"], [aria-label*="Patrocinado"]'
    );
    if (sponsoredLabel) return true;

    // 3. Check for keywords in text content (handles many cases)
    const text = element.textContent?.toLowerCase() || "";
    const sponsoredKeywords = [
      "sponsored",
      "sponsorisé",
      "gesponsert",
      "patrocinado",
      "publicité",
      "promoted",
      "suggested for you",
      "sugerido para ti",
    ];

    if (sponsoredKeywords.some((keyword) => text.includes(keyword))) {
      return true;
    }

    return false;
  }

  // Get post timestamp
  getPostTimestamp(element) {
    if (!element) return Date.now();

    // Try to find timestamp element
    const timestampSelectors = [
      "abbr[data-utime]",
      "abbr[data-timestamp]",
      'span[id*="feed_subtitle"]',
      'a[href*="/posts/"] abbr',
      'a[href*="/photos/"] abbr',
    ];

    for (const selector of timestampSelectors) {
      try {
        const timestampEl = element.querySelector?.(selector);
        if (timestampEl) {
          const utime = timestampEl.getAttribute?.("data-utime");
          if (utime) {
            return parseInt(utime) * 1000; // Convert to ms
          }

          const timestamp = timestampEl.getAttribute?.("data-timestamp");
          if (timestamp) {
            return parseInt(timestamp);
          }
        }
      } catch (e) {
        // Skip invalid selector
        continue;
      }
    }

    // Fallback to current time
    return Date.now();
  }

  // Get post URL
  getPostUrl(element) {
    if (!element) return null;

    // Look for permalink
    const permalinkSelectors = [
      'a[href*="/posts/"]',
      'a[href*="/photos/"]',
      'a[href*="/videos/"]',
      'a[href*="/permalink/"]',
    ];

    for (const selector of permalinkSelectors) {
      try {
        const link = element.querySelector?.(selector);
        if (link?.href) {
          return link.href.split("?")[0]; // Remove query params
        }
      } catch (e) {
        // Skip invalid selector
        continue;
      }
    }

    return null;
  }

  // Clear processed posts cache (memory management)
  clearCache() {
    const maxCacheSize = 1000;
    if (this.processedPosts.size > maxCacheSize) {
      const toKeep = Array.from(this.processedPosts).slice(-500);
      this.processedPosts = new Set(toKeep);
    }

    if (this.processedGraphQLPosts.size > maxCacheSize) {
      const toKeep = Array.from(this.processedGraphQLPosts).slice(-500);
      this.processedGraphQLPosts = new Set(toKeep);
    }
  }

  // Reset all per-page state (called on SPA navigation)
  resetProcessed() {
    this.processedPosts.clear();
    this.processedGraphQLPosts.clear();
  }

  // Get stats
  getStats() {
    return {
      processedCount: this.processedPosts.size,
      processedGraphQLCount: this.processedGraphQLPosts.size,
      postIdCounter: this.postIdCounter,
    };
  }
}

// Export
window.FBPostDetector = FBPostDetector;
