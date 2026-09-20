/* Four browser-sized, lossless horizontal strips replace one giant decode. */
(() => {
  'use strict';
  window.createFrameStore = (meta, onReady, onError) => {
    const { pages, framesPerPage } = meta.runtime;
    const cache = new Map(), jobs = new Map(), queue = [];
    const limit = 4;
    let required = new Set(), running = false, failed = false, peakPages = 0;
    const dispose = entry => { entry.sheet.close(); entry.motion?.close(); };
    const pageAt = frame => Math.floor(frame / framesPerPage);
    const pairAt = frame => [...new Set([pageAt(Math.floor(frame)), pageAt(Math.min(Math.floor(frame) + 1, meta.frames - 1))])];
    async function decode(url, width, height) {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Animation strip: HTTP ${response.status} (${url})`);
      const bitmap = await createImageBitmap(await response.blob());
      if (bitmap.width !== width || bitmap.height !== height) {
        bitmap.close(); throw new Error(`Animation strip dimensions do not match (${url})`);
      }
      return bitmap;
    }
    function touch(index) {
      const entry = cache.get(index);
      if (entry) { cache.delete(index); cache.set(index, entry); }
      return entry;
    }
    async function pump() {
      if (running || failed || !queue.length) return;
      // Reversals can change which queued page is needed first.
      const urgent = queue.findIndex(job => required.has(job.index));
      const job = queue.splice(urgent < 0 ? 0 : urgent, 1)[0];
      running = true;
      while (cache.size >= limit) {
        const victim = [...cache.keys()].find(index => !required.has(index));
        if (victim === undefined) break;
        dispose(cache.get(victim)); cache.delete(victim);
      }
      const page = pages[job.index];
      const results = await Promise.allSettled([
        decode(page.sheet, page.count * meta.cell.width, meta.cell.height),
        decode(page.motion, page.count * meta.motion.width, meta.motion.height * 2)
      ]);
      if (results[0].status === 'rejected') {
        if (results[1].status === 'fulfilled') results[1].value.close();
        failed = true; job.reject(results[0].reason);
        for (const waiting of queue.splice(0)) waiting.reject(results[0].reason);
        jobs.clear(); onError(results[0].reason);
      } else {
        // A missing optional vector strip uses an ordinary frame blend.
        cache.set(job.index, { sheet: results[0].value, motion: results[1].status === 'fulfilled' ? results[1].value : null });
        peakPages = Math.max(peakPages, cache.size);
        jobs.delete(job.index); job.resolve(); onReady();
      }
      running = false; pump();
    }
    function request(index) {
      if (touch(index)) return Promise.resolve();
      if (failed) return Promise.reject(new Error('Animation strip loading failed'));
      if (jobs.has(index)) return jobs.get(index).promise;
      let resolve, reject;
      const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
      const job = { index, promise, resolve, reject };
      jobs.set(index, job); queue.push(job); pump();
      return promise;
    }
    return {
      ready(frame) { return pairAt(frame).every(index => cache.has(index)); },
      load(frame) {
        const indices = pairAt(frame); required = new Set(indices);
        return Promise.all(indices.map(request));
      },
      prepare(frame) { this.load(frame).catch(() => {}); },
      warm(frame, direction) {
        const at = pageAt(Math.floor(frame));
        const candidates = direction ? [at + direction, at + direction * 2] : [at - 1, at + 1];
        for (const index of candidates) if (index >= 0 && index < pages.length) request(index).catch(() => {});
      },
      cell(frame) {
        const index = pageAt(frame), entry = touch(index);
        return { image: entry.sheet, x: (frame - pages[index].start) * meta.cell.width };
      },
      getFrame(frame) {
        const index = pageAt(frame), entry = touch(index);
        return entry?.motion ? { image: entry.motion, x: (frame - pages[index].start) * meta.motion.width } : null;
      },
      get stats() {
        return { pages: cache.size, peakPages, limit, pending: jobs.size,
          decodedBytes: [...cache.values()].reduce((sum, entry) => sum + entry.sheet.width * entry.sheet.height * 4 + (entry.motion ? entry.motion.width * entry.motion.height * 4 : 0), 0) };
      }
    };
  };
})();
