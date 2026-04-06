(function() {
  if (window.__cartProgressInit) return;
  window.__cartProgressInit = true;

  var WRAPPER_SEL = '.cart-progress-wrapper';
  var debounceTimer;
  var isUpdating = false;
  var isOwnCartCall = false;
  var missedUpdate = false;
  var DEBOUNCE_MS = 300;
  var OVERLAY_COOLDOWN_MS = 500;
  var REFRESH_DELAY_MS = 100;

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

  async function refreshDrawer() {
    try {
      var comps = document.querySelectorAll('cart-items-component');
      var sectionIds = [];
      comps.forEach(function(c) { if (c.dataset.sectionId) sectionIds.push(c.dataset.sectionId); });
      if (sectionIds.length === 0) return;

      await new Promise(function(r) { setTimeout(r, REFRESH_DELAY_MS); });

      var res = await fetch('/?sections=' + sectionIds.join(','));
      var data = await res.json();

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
      window.location.reload();
    }
  }

  // After refreshDrawer replaces DOM, keep overlay active to block rapid clicks
  // on the newly-enabled buttons, then re-fetch config from fresh DOM
  async function refreshAndCooldown() {
    await refreshDrawer();
    await new Promise(function(r) { setTimeout(r, OVERLAY_COOLDOWN_MS); });
    hideCartLoading();
    return getConfig();
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

  // Build consolidation updates for ALL duplicate variant lines (not just gift).
  // Groups by variant_id + serialized properties. Sums quantities for non-gift,
  // forces qty 1 for gift variant.
  function buildConsolidationUpdates(items, giftVariant) {
    var groups = {};
    items.forEach(function(item) {
      var key = String(item.variant_id) + ':' + serializeProps(item.properties);
      if (!groups[key]) groups[key] = [];
      groups[key].push({ key: item.key, quantity: item.quantity, variant_id: item.variant_id });
    });

    var updates = {};
    var needsConsolidation = false;

    Object.keys(groups).forEach(function(groupKey) {
      var lines = groups[groupKey];
      if (lines.length <= 1) return;

      needsConsolidation = true;
      var isGift = String(lines[0].variant_id) === String(giftVariant);
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

  async function update() {
    if (isUpdating) return;
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
      var consolidationUpdates = buildConsolidationUpdates(cart.items, config.giftVariant);
      if (consolidationUpdates) {
        showCartLoading();
        await cartApiCall('/cart/update.js', { updates: consolidationUpdates });
        config = await refreshAndCooldown();
        cart = await getCart();
        total = calcSubtotal(cart.items, config.giftVariant);
        hasGift = cart.items.some(function(item) {
          return String(item.variant_id) === String(config.giftVariant);
        });
      }

      // --- ADD GIFT: when subtotal (excluding gift) crosses threshold ---
      if (total >= config.gift && !hasGift) {
        showCartLoading();
        var res = await cartApiCall('/cart/add.js', {
          items: [{ id: parseInt(config.giftVariant, 10), quantity: 1, properties: { _gift: "true" } }]
        });
        if (res && res.ok) {
          config = await refreshAndCooldown();
        } else {
          hideCartLoading();
        }
        cart = await getCart();
        total = calcSubtotal(cart.items, config.giftVariant);
        updateUI(config, total);
        reorderGiftItems();
        return;
      }

      // --- REMOVE GIFT: when subtotal drops below threshold ---
      if (total < config.gift && hasGift) {
        var giftItem = cart.items.find(function(item) {
          return String(item.variant_id) === String(config.giftVariant);
        });
        if (giftItem) {
          showCartLoading();
          var removeUpdates = {};
          removeUpdates[giftItem.key] = 0;
          await cartApiCall('/cart/update.js', { updates: removeUpdates });
          config = await refreshAndCooldown();
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
      missedUpdate = true;
      return;
    }
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
