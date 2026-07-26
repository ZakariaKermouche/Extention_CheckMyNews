// content-scripts/fbStorageManager.js

class FBStorageManager {
  constructor() {
    this.queue = [];
    this.maxQueueSize = 10;
    this.sendInterval = 10000; // 10 seconds for debug
    this.sendTimer = null;
    this.isSending = false;
    this.contextInvalidated = false;
    this.saveLock = Promise.resolve();
  }

  log(...args) {
    console.log("[CMN] StorageManager:", ...args);
  }

  // Initialize
  async init() {
    this.log("Initializing...");
    await this.loadUnsentData();
    this.startPeriodicSend();
    this.setupUnloadHandler();
  }

  // Add post to queue
  async addPost(postData) {
    if (!postData) return false;

    const pid = String(postData.id || postData.post_id || postData.postId);
    if (!pid || pid === "undefined" || pid === "null") return false;

    let existingIdx = this.queue.findIndex(
      (p) => String(p?.id || p?.post_id || p?.postId) === pid
    );

    if (existingIdx === -1 && postData.matchFingerprint) {
      existingIdx = this.queue.findIndex((p) => p.matchFingerprint === postData.matchFingerprint);
      
      if (existingIdx !== -1) {
        const existing = this.queue[existingIdx];
        this.log("Merging duplicate posts with same fingerprint but different IDs:", existing.id, pid);
        
        if (postData.source !== "dom_standalone" && existing.source === "dom_standalone") {
           if (existing.inDOM) {
             postData.inDOM = true;
             postData.domFoundAt = existing.domFoundAt;
           }
        } 
        else if (postData.source === "dom_standalone" && existing.source !== "dom_standalone") {
           this.queue[existingIdx].inDOM = true;
           this.queue[existingIdx].domFoundAt = Date.now();
           if (!this.queue[existingIdx].message && postData.message) {
             this.queue[existingIdx].message = postData.message;
           }
           await this.saveUnsentData();
           return true;
        }
      }
    }

    if (existingIdx !== -1) {
      this.log("Updating existing post in queue:", pid);
      this.queue[existingIdx] = {
        ...this.queue[existingIdx],
        ...postData,
        updatedAt: Date.now(),
      };
      await this.saveUnsentData();
      return true;
    }

    this.log("Adding new post to queue:", pid);
    this.queue.push({
      ...postData,
      queuedAt: Date.now(),
    });

    await this.saveUnsentData();

    if (this.queue.length >= this.maxQueueSize) {
      this.log("Queue full, triggering send...");
      this.sendData();
    }

    return true;
  }

  // Update a queued post by id/post_id
  async updatePost(id, updates = {}) {
    if (!id) return;
    const idx = this.queue.findIndex(
      (p) => String(p?.id || p?.post_id || p?.postId) === String(id)
    );
    if (idx === -1) return;

    this.queue[idx] = {
      ...this.queue[idx],
      ...updates,
      updatedAt: Date.now(),
    };
    await this.saveUnsentData();
  }

  startPeriodicSend() {
    if (this.sendTimer) clearInterval(this.sendTimer);
    this.sendTimer = setInterval(() => {
      if (this.queue.length > 0) {
        this.log("Periodic timer: sending", this.queue.length, "posts");
        this.sendData();
      }
    }, this.sendInterval);
  }

  stopPeriodicSend() {
    if (this.sendTimer) {
      clearInterval(this.sendTimer);
      this.sendTimer = null;
    }
  }

  async sendData() {
    if (this.isSending) return;
    if (this.queue.length === 0 || this.contextInvalidated) return;

    this.isSending = true;
    const dataToSend = [...this.queue];
    this.queue = [];

    try {
      this.log("Sending data to background...", { count: dataToSend.length });
      if (!chrome?.runtime?.id) throw new Error("Extension context invalidated");

      const response = await chrome.runtime.sendMessage({
        type: "POSTS_COLLECTED",
        data: dataToSend,
        metadata: {
          timestamp: Date.now(),
          pageUrl: window.location.href,
          count: dataToSend.length,
        },
      });

      if (response?.ok || response?.success) {
        this.log("Successfully sent to background. Count:", dataToSend.length);
        if (response.mappings) this.applyDbIdMappings(dataToSend, response.mappings);
        await this.removeFromStorage(dataToSend);
      } else {
        console.warn("[CMN] Background rejected posts!", { 
          count: dataToSend.length, 
          response,
          firstPostId: dataToSend[0]?.id
        });
        this.queue.unshift(...dataToSend);
      }
    } catch (error) {
      const invalidated =
        error?.message?.includes("Extension context invalidated") ||
        error?.message?.includes("Receiving end does not exist");
      if (invalidated) {
        this.log("Context invalidated, stopping sender.");
        this.contextInvalidated = true;
        this.queue = dataToSend;
        return;
      }
      this.log("Send error, re-queuing...", error.message);
      this.queue.unshift(...dataToSend);
      await this.saveUnsentData();
    } finally {
      this.isSending = false;
    }
  }

  applyDbIdMappings(dataToSend, mappings) {
    if (!Array.isArray(mappings) || mappings.length === 0) return;
    const byKey = new Map();
    for (const m of mappings) {
      const key = m?.adanalyst_ad_id ? String(m.adanalyst_ad_id) : null;
      if (!key || !m?.dbId) continue;
      byKey.set(key, String(m.dbId));
    }
    if (byKey.size === 0) return;

    for (const item of dataToSend) {
      const adanalystId = item?.adanalyst_ad_id || item?.post_id || item?.id;
      if (!adanalystId || !byKey.has(String(adanalystId))) continue;
      const dbId = byKey.get(String(adanalystId));
      item.dbId = dbId;
      if (window?.CMN?.graphqlPostsMap && item?.post_id) {
        const post = window.CMN.graphqlPostsMap.get(String(item.post_id));
        if (post) post.dbId = dbId;
      }
    }
  }

  async saveUnsentData() {
    try {
      const prevLock = this.saveLock;
      let resolveLock;
      this.saveLock = new Promise(resolve => { resolveLock = resolve; });
      await prevLock;

      try {
        if (!chrome?.runtime?.id || !chrome?.storage?.local) {
          console.error("[CMN] StorageManager: chrome.storage.local not available or context invalidated");
          return;
        }
        
        const result = await chrome.storage.local.get(["cmn_unsent_posts"]);
        const existingPosts = Array.isArray(result.cmn_unsent_posts) ? result.cmn_unsent_posts : [];
        
        this.log("saveUnsentData: current queue size:", this.queue.length, "existing in storage:", existingPosts.length);

        const postMap = new Map();
        existingPosts.forEach(p => {
          const pid = String(p.id || p.post_id || p.postId);
          if (pid && pid !== "undefined" && pid !== "null") postMap.set(pid, p);
        });
        
        this.queue.forEach(p => {
          const pid = String(p.id || p.post_id || p.postId);
          if (pid && pid !== "undefined" && pid !== "null") postMap.set(pid, p);
          else console.warn("[CMN] StorageManager: found post with invalid ID in queue", p);
        });

        const totalToSave = Array.from(postMap.values());
        await chrome.storage.local.set({
          cmn_unsent_posts: totalToSave,
          cmn_last_save: Date.now(),
        });
        this.log("Storage updated. Saved", totalToSave.length, "posts to cmn_unsent_posts");
      } finally {
        resolveLock();
      }
    } catch (error) {
      console.error("[CMN] saveUnsentData fatal error:", error);
    }
  }

  async removeFromStorage(sentPosts) {
    const prevLock = this.saveLock;
    let resolveLock;
    this.saveLock = new Promise(resolve => { resolveLock = resolve; });
    await prevLock;

    try {
      if (!chrome?.storage?.local) return;
      const sentIds = new Set(sentPosts.map(p => String(p.id || p.post_id || p.postId)));
      const result = await chrome.storage.local.get(["cmn_unsent_posts"]);
      const existingPosts = Array.isArray(result.cmn_unsent_posts) ? result.cmn_unsent_posts : [];
      const remainingPosts = existingPosts.filter(p => !sentIds.has(String(p.id || p.post_id || p.postId)));
      
      if (remainingPosts.length === 0) {
        await chrome.storage.local.remove(["cmn_unsent_posts"]);
      } else {
        await chrome.storage.local.set({
          cmn_unsent_posts: remainingPosts,
          cmn_last_save: Date.now()
        });
      }
      this.log("Removed sent posts from storage. Remaining:", remainingPosts.length);
    } catch (error) {
    } finally {
      resolveLock();
    }
  }

  async loadUnsentData() {
    try {
      if (!chrome?.storage?.local) return;
      const result = await chrome.storage.local.get(["cmn_unsent_posts"]);
      if (result.cmn_unsent_posts && Array.isArray(result.cmn_unsent_posts)) {
        this.log("Loaded unsent posts from storage:", result.cmn_unsent_posts.length);
        const existingIds = new Set(this.queue.map(p => String(p.id || p.post_id)));
        for (const post of result.cmn_unsent_posts) {
          const pid = String(post.id || post.post_id);
          if (!existingIds.has(pid)) {
            this.queue.push(post);
            existingIds.add(pid);
          }
        }
      }
    } catch (error) {
    }
  }

  setupUnloadHandler() {
    window.addEventListener("beforeunload", () => {
      this.log("Page unloading, saving remaining queue...");
      if (this.queue.length > 0) {
        this.sendData();
        if (chrome?.runtime?.id) this.saveUnsentData();
      }
    });
  }

  destroy() {
    this.stopPeriodicSend();
    if (this.queue.length > 0) this.saveUnsentData();
  }
}

window.FBStorageManager = FBStorageManager;
