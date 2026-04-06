(function() {
  if (window.__cartProgressInit) return;
  window.__cartProgressInit = true;

  var WRAPPER_SEL = '.cart-progress-wrapper';
  var debounceTimer;
  var isUpdating = false;
  var isOwnCartCall = false;
  var missedUpdate = false;
  var DEBOUNCE_MS = 800;

  function getConfig() {
    var el = document.querySelector(WRAPPER_SEL);
    if (!el) return null;
    return {
      el: el,
      shipping: parseInt(el.dataset.shippingThreshold, 10),
      gift: parseInt(el.dataset.giftThreshold, 10),
      giftVariant: el.dataset.giftVariantId,
      currencySymbol: el.dataset.currencySymbol || '$'
    };
  }

  function formatMoney(cents, symbol) {
    return symbol + (cents / 100).toFixed(2);
  }

  // Calculate cart subtotal EXCLUDING the gift item to prevent circular dependency.
  // DISABLED: old $0-gift approach used cart.items_subtotal_price directly (no exclusion needed
  // since the gift was $0). Kept here in case we need to revert from BXGY back to $0-gift:
  //   var total = cart.items_subtotal_price;
  function calcSubtotal(items, giftVariant) {
    return items.reduce(function(sum, item) {
      var isGift = (item.properties && item.properties._gift === 'true') ||
                   String(item.variant_id) === String(giftVariant);
      return isGift ? sum : sum + item.final_line_price;
    }, 0);
  }

  function serializeProps(props) {
    if (!props || typeof props !== 'object') return '{}';
    return JSON.stringify(props);
  }

  async function getCart() {
    var res = await fetch('/cart.json');
    if (!res.ok) throw new Error('Cart fetch failed');
    return res.json();
  }

  function showCartLoading() {
    document.querySelectorAll('cart-items-component').forEach(function(c) {
      c.classList.add('cart-gift-updating');
    });
  }

  function hideCartLoading() {
    document.querySelectorAll('cart-items-component').forEach(function(c) {
      c.classList.remove('cart-gift-updating');
    });
  }

  async function cartApiCall(url, body) {
    isOwnCartCall = true;
    try {
      var res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (res.status === 429) {
        await new Promise(function(r) { setTimeout(r, 1000); });
        return cartApiCall(url, body);
      }
      return res;
    } finally {
      isOwnCartCall = false;
    }
  }

  // Trigger the theme to re-render cart sections using its own Section Rendering API.
  // Unlike the old refreshDrawer(), this sends a /cart/update.js with sections param,
  // which returns section HTML that the theme's morph system can process.
  // This avoids raw DOM replacement that caused button re-enabling and line splitting.
  async function triggerSectionRefresh() {
    try {
      var comps = document.querySelectorAll('cart-items-component');
      var sectionIds = [];
      comps.forEach(function(c) { if (c.dataset.sectionId) sectionIds.push(c.dataset.sectionId); });
      if (sectionIds.length === 0) return;

      // Fetch fresh section HTML
      var res = await fetch('/?sections=' + sectionIds.join(','));
      var data = await res.json();

      // Replace section content — but keep the loading overlay active
      comps.forEach(function(comp) {
        var html = data[comp.dataset.sectionId];
        if (!html) return;
        var parser = new DOMParser();
        var doc = parser.parseFromString(html, 'text/html');
        var newComp = doc.querySelector('cart-items-component');
        if (!newComp) return;
        Array.from(comp.children).forEach(function(child) { child.remove(); });
        Array.from(newComp.children).forEach(function(child) { comp.appendChild(child); });
      });

      reorderGiftItems();
    } catch(e) {
      // Silently fail — the next cart:update event will refresh naturally
    }
  }

  function reorderGiftItems() {
    document.querySelectorAll('tbody[role="rowgroup"]').forEach(function(tbody) {
      var giftRows = tbody.querySelectorAll('.cart-items__table-row--gift');
      giftRows.forEach(function(row) { tbody.appendChild(row); });
    });
  }

  function updateUI(config, total) {
    var bar = config.el.querySelector('.cart-progress');
    if (!bar) return;

    var progress, statusText, helperText, isComplete;
    var sym = config.currencySymbol;

    if (total >= config.gift) {
      progress = 100;
      statusText = 'You got free shipping & a free gift!';
      helperText = '';
      isComplete = true;
    } else if (total >= config.shipping) {
      progress = 50 + ((total - config.shipping) / (config.gift - config.shipping)) * 50;
      statusText = 'Free gift at ' + formatMoney(config.gift, sym);
      helperText = 'Just ' + formatMoney(config.gift - total, sym) + ' away from a free gift!';
      isComplete = false;
    } else {
      progress = (total / config.shipping) * 50;
      statusText = 'Free shipping at ' + formatMoney(config.shipping, sym);
      helperText = 'Just ' + formatMoney(config.shipping - total, sym) + ' away from free shipping!';
      isComplete = false;
    }

    var fill = bar.querySelector('.cart-progress__fill');
    var status = bar.querySelector('.cart-progress__status');
    var helper = bar.querySelector('.cart-progress__helper');

    if (fill) {
      fill.style.width = Math.min(progress, 100) + '%';
      fill.classList.toggle('cart-progress__fill--complete', isComplete);
    }
    if (status) {
      status.textContent = statusText;
      status.classList.toggle('cart-progress__status--success', isComplete);
    }
    if (helper) {
      helper.textContent = helperText;
      helper.style.display = helperText ? '' : 'none';
    }
    bar.classList.toggle('is-complete', isComplete);
    bar.setAttribute('aria-valuenow', Math.round(progress));
    bar.setAttribute('aria-label', statusText);
  }

  // Find duplicate variant groups. Returns object keyed by variant_id if any
  // duplicates exist, or null if no consolidation needed.
  function findDuplicateGroups(items) {
    var groups = {};
    items.forEach(function(item) {
      var vid = String(item.variant_id);
      if (!groups[vid]) groups[vid] = [];
      groups[vid].push({ key: item.key, quantity: item.quantity, variant_id: item.variant_id });
    });

    var hasDuplicates = false;
    var result = {};
    Object.keys(groups).forEach(function(vid) {
      if (groups[vid].length > 1) {
        hasDuplicates = true;
        result[vid] = groups[vid];
      }
    });

    return hasDuplicates ? result : null;
  }

  // Build consolidation updates (kept for test compatibility).
  function buildConsolidationUpdates(items, giftVariant) {
    var groups = {};
    items.forEach(function(item) {
      var vid = String(item.variant_id);
      if (!groups[vid]) groups[vid] = [];
      groups[vid].push({ key: item.key, quantity: item.quantity, variant_id: item.variant_id });
    });

    var updates = {};
    var needsConsolidation = false;

    Object.keys(groups).forEach(function(vid) {
      var lines = groups[vid];
      if (lines.length <= 1) return;

      needsConsolidation = true;
      var isGift = vid === String(giftVariant);
      var totalQty = lines.reduce(function(s, l) { return s + l.quantity; }, 0);

      lines.forEach(function(l, i) {
        if (i === 0) {
          updates[l.key] = isGift ? 1 : totalQty;
        } else {
          updates[l.key] = 0;
        }
      });
    });

    return needsConsolidation ? updates : null;
  }

  // Perform a cart modification, refresh the drawer, and wait for stability.
  // Keeps loading overlay active the entire time to prevent rapid clicks.
  async function cartModifyAndRefresh(apiUrl, body) {
    showCartLoading();
    var res = await cartApiCall(apiUrl, body);
    if (!res || !res.ok) {
      hideCartLoading();
      return;
    }
    await triggerSectionRefresh();
    // Re-apply loading overlay (triggerSectionRefresh replaced DOM, overlay class was on parent)
    showCartLoading();
    // Wait for any in-flight theme operations to settle
    await new Promise(function(r) { setTimeout(r, 500); });
    hideCartLoading();
  }

  // Consolidate duplicate lines by removing extras one at a time.
  // Re-fetches cart after each removal to work with fresh line state,
  // avoiding interference from concurrent theme operations.
  async function consolidateLines(giftVariant) {
    showCartLoading();
    var maxRetries = 5;
    for (var attempt = 0; attempt < maxRetries; attempt++) {
      var cart = await getCart();
      var groups = {};
      cart.items.forEach(function(item) {
        var vid = String(item.variant_id);
        if (!groups[vid]) groups[vid] = [];
        groups[vid].push({ key: item.key, quantity: item.quantity });
      });

      // Find first duplicate group
      var foundDuplicate = false;
      for (var vid in groups) {
        var lines = groups[vid];
        if (lines.length <= 1) continue;
        foundDuplicate = true;

        // Remove the LAST duplicate line (safest — keeps the oldest line)
        var lineToRemove = lines[lines.length - 1];
        var lineToKeep = lines[0];
        var isGift = vid === String(giftVariant);
        var totalQty = isGift ? 1 : lineToKeep.quantity + lineToRemove.quantity;

        console.log('[cart-progress] Consolidating: remove', lineToRemove.key, 'merge qty into', lineToKeep.key, '→', totalQty);

        // First remove the duplicate
        await cartApiCall('/cart/change.js', { id: lineToRemove.key, quantity: 0 });
        // Then set the kept line to the correct quantity
        await cartApiCall('/cart/change.js', { id: lineToKeep.key, quantity: totalQty });

        break; // Only handle one duplicate per iteration, then re-fetch
      }

      if (!foundDuplicate) break;
    }
    // Reload page to show merged state — theme's own morph would overwrite
    // our section refresh with stale pre-consolidation data
    console.log('[cart-progress] Consolidation complete, reloading page');
    window.location.reload();
  }

  async function update() {
    if (isUpdating) { console.log('[cart-progress] update: SKIPPED (isUpdating)'); return; }
    console.log('[cart-progress] update: STARTING');
    isUpdating = true;
    try {
      var config = getConfig();
      if (!config || !config.giftVariant) return;

      var cart = await getCart();
      var total = calcSubtotal(cart.items, config.giftVariant);
      var hasGift = cart.items.some(function(item) {
        return String(item.variant_id) === String(config.giftVariant);
      });

      // --- CONSOLIDATION: merge ALL duplicate variant lines ---
      console.log('[cart-progress] update() running. Items:', cart.items.length, 'Total:', total, 'HasGift:', hasGift);
      var duplicateGroups = findDuplicateGroups(cart.items);
      if (duplicateGroups) {
        console.log('[cart-progress] Duplicates found, consolidating...');
        await consolidateLines(config.giftVariant);
        config = getConfig();
        cart = await getCart();
        total = calcSubtotal(cart.items, config.giftVariant);
        hasGift = cart.items.some(function(item) {
          return String(item.variant_id) === String(config.giftVariant);
        });
      }

      // --- ADD GIFT ---
      if (total >= config.gift && !hasGift) {
        await cartModifyAndRefresh('/cart/add.js', {
          items: [{ id: parseInt(config.giftVariant, 10), quantity: 1, properties: { _gift: "true" } }]
        });
        config = getConfig();
        cart = await getCart();
        total = calcSubtotal(cart.items, config.giftVariant);
        updateUI(config, total);
        reorderGiftItems();
        return;
      }

      // --- REMOVE GIFT ---
      if (total < config.gift && hasGift) {
        var giftItem = cart.items.find(function(item) {
          return String(item.variant_id) === String(config.giftVariant);
        });
        if (giftItem) {
          await cartModifyAndRefresh('/cart/change.js', { id: giftItem.key, quantity: 0 });
          config = getConfig();
          cart = await getCart();
          total = calcSubtotal(cart.items, config.giftVariant);
          updateUI(config, total);
          reorderGiftItems();
          return;
        }
      }

      // --- NO CHANGE: just update the progress bar UI ---
      updateUI(config, total);
      reorderGiftItems();
    } catch (e) {
      hideCartLoading();
      console.error('Cart progress bar:', e);
    } finally {
      isUpdating = false;
      if (missedUpdate) {
        missedUpdate = false;
        scheduleUpdate();
      }
    }
  }

  function scheduleUpdate() {
    if (isUpdating) {
      console.log('[cart-progress] scheduleUpdate: BLOCKED (isUpdating), setting missedUpdate');
      missedUpdate = true;
      return;
    }
    console.log('[cart-progress] scheduleUpdate: setting timer for', DEBOUNCE_MS, 'ms');
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(update, DEBOUNCE_MS);
  }

  // Intercept fetch to detect cart changes from any source
  var originalFetch = window.fetch;
  window.fetch = function() {
    var args = arguments;
    var url = typeof args[0] === 'string' ? args[0] : '';
    return originalFetch.apply(this, args).then(function(response) {
      if (!isOwnCartCall && url.indexOf('/cart/') !== -1 && url.indexOf('/cart.json') === -1) {
        scheduleUpdate();
      }
      return response;
    });
  };

  document.addEventListener('cart:update', scheduleUpdate);

  // Initial run
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() { update(); reorderGiftItems(); });
  } else {
    update();
    reorderGiftItems();
  }

  // Reorder after Horizon morph
  document.addEventListener('cart:update', function() {
    setTimeout(reorderGiftItems, 200);
  });

  document.addEventListener('click', function() {
    setTimeout(reorderGiftItems, 300);
  });
})();
