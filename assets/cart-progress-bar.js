(function() {
  if (window.__cartProgressInit) return;
  window.__cartProgressInit = true;

  var WRAPPER_SEL = '.cart-progress-wrapper';
  var debounceTimer;
  var isUpdating = false;
  var isOwnCartCall = false;

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

      await new Promise(function(r) { setTimeout(r, 300); });

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

      // --- CONSOLIDATION: fix duplicate gift lines from rapid-click race conditions ---
      var giftLines = [];
      cart.items.forEach(function(item) {
        if (String(item.variant_id) === String(config.giftVariant)) {
          giftLines.push({ key: item.key, quantity: item.quantity });
        }
      });

      if (giftLines.length > 1 || (giftLines.length === 1 && giftLines[0].quantity > 1)) {
        showCartLoading();
        var updates = {};
        giftLines.forEach(function(g, i) {
          updates[g.key] = (i === 0) ? 1 : 0;
        });
        await cartApiCall('/cart/update.js', { updates: updates });
        await refreshDrawer();
        config = getConfig();
        hideCartLoading();
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
          await refreshDrawer();
          config = getConfig();
        }
        hideCartLoading();
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
          await refreshDrawer();
          config = getConfig();
          hideCartLoading();
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
    }
  }

  function scheduleUpdate() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(update, 150);
  }

  // Intercept fetch to detect cart changes
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
