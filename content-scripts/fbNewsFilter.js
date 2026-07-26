// content-scripts/fbNewsFilter.js

/**
 * FBNewsFilter
 * Responsabilité : Filtre les posts pour ne garder que ceux provenant de sources 
 * d'actualités connues. Il compare les URLs des posts et des liens partagés avec 
 * une liste blanche de domaines médias.
 */
class FBNewsFilter {
  constructor() {
    this.newsDomains = this.loadNewsDomains();
    this.customDomains = [];
  }

  // Load news domains list
  loadNewsDomains() {
    // Default news domains
    return [
      // US News
      "nytimes.com",
      "washingtonpost.com",
      "wsj.com",
      "usatoday.com",
      "latimes.com",
      "chicagotribune.com",
      "nydailynews.com",

      // Broadcast News
      "cnn.com",
      "foxnews.com",
      "nbcnews.com",
      "abcnews.go.com",
      "cbsnews.com",
      "msnbc.com",
      // International / French
      "bbc.com",
      "bbc.co.uk",
      "bbcsport",
      "bbcnews",
      "bbcnewsfr",
      "theguardian.com",
      "telegraph.co.uk",
      "independent.co.uk",
       "lemonde.fr",
      "lefigaro.fr",
      "liberation.fr",
      "francetvinfo.fr",
      "bfmtv.com",
      "cnews.fr",
      "cnews",
      "lci.fr",
      "europe1.fr",
      "rmc.bfmtv.com",
      "rmc",
      "leparisien.fr",
      "20minutes.fr",
      "elpais.com",

      // Wire Services
      "reuters.com",
      "apnews.com",
      "afp.com",

      // Tech News
      "techcrunch.com",
      "theverge.com",
      "wired.com",
      "arstechnica.com",

      // Business
      "bloomberg.com",
      "forbes.com",
      "fortune.com",
      "businessinsider.com",

      // Add more as needed
    ];
  }
  // Check if post is from news source
  isNewsPost(postData) {
    if (!postData) return false;

    // 1. Check shared link (if any)
    const url = postData.externalUrl || postData.url;
    if (url) {
      const domain = postData.externalDomain || this.extractDomain(url);
      if (this.isNewsDomain(domain)) return true;
    }

    // 2. Check author/page URL (very important for Page/Search views)
    const authorUrl = postData.author?.url;
    if (authorUrl) {
      const authorDomain = this.extractDomain(authorUrl);
      if (this.isNewsDomain(authorDomain)) return true;
    }
    
    // 3. Check author ID (some pages use usernames like 'CNEWSofficiel')
    const authorId = postData.author?.id;
    if (authorId && typeof authorId === 'string') {
      if (this.isNewsDomain(authorId)) return true;
    }

    // 1b. Check landing pages (detected links)
    if (Array.isArray(postData.landingPages)) {
      for (const link of postData.landingPages) {
        const d = this.extractDomain(link);
        if (this.isNewsDomain(d)) return true;
      }
    }

    // 4. Check author name
    const authorName = postData.author?.name;
    if (authorName) {
      if (this.isNewsDomain(authorName)) return true;
    }

    return false;
  }

  // Helper to extract domain from URL
  extractDomain(url) {
    if (!url || typeof url !== "string") return null;
    try {
      const hostname = new URL(url).hostname;
      return hostname.toLowerCase().replace("www.", "");
    } catch (e) {
      return url.toLowerCase().replace("www.", "");
    }
  }

  // Check if domain is a news domain
  isNewsDomain(domain) {
    if (!domain) return false;

    const normalizedDomain = domain.toLowerCase().replace("www.", "");

    // Check exact match
    if (this.newsDomains.includes(normalizedDomain)) {
      return true;
    }

    // Check if any news domain is contained in the domain
    return this.newsDomains.some(
      (newsDomain) =>
        normalizedDomain.includes(newsDomain) ||
        newsDomain.includes(normalizedDomain)
    );
  }

  // Add custom domain
  addCustomDomain(domain) {
    const normalized = domain.toLowerCase().replace("www.", "");
    if (!this.customDomains.includes(normalized)) {
      this.customDomains.push(normalized);
      this.newsDomains.push(normalized);
    }
  }

  // Remove custom domain
  removeCustomDomain(domain) {
    const normalized = domain.toLowerCase().replace("www.", "");
    const index = this.customDomains.indexOf(normalized);
    if (index > -1) {
      this.customDomains.splice(index, 1);
      const newsIndex = this.newsDomains.indexOf(normalized);
      if (newsIndex > -1) {
        this.newsDomains.splice(newsIndex, 1);
      }
    }
  }

  // Get domain category
  getDomainCategory(domain) {
    if (!domain) return null;

    const categories = {
      mainstream: ["nytimes.com", "washingtonpost.com", "cnn.com", "bbc.com"],
      wire: ["reuters.com", "apnews.com", "afp.com"],
      tech: ["techcrunch.com", "theverge.com", "wired.com"],
      business: ["bloomberg.com", "forbes.com", "wsj.com"],
    };

    for (const [category, domains] of Object.entries(categories)) {
      if (domains.some((d) => domain.includes(d))) {
        return category;
      }
    }

    return "other";
  }

  // Get all domains
  getAllDomains() {
    return [...this.newsDomains];
  }

  // Get custom domains only
  getCustomDomains() {
    return [...this.customDomains];
  }
}

// Export
window.FBNewsFilter = FBNewsFilter;
