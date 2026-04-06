(function() {
  if (window.__cartProgressInit) return;
  window.__cartProgressInit = true;

  var WRAPPER_SEL = '.cart-progress-wrapper';
  var debounceTimer;
  var isUpdating = false;
  var isOwnCartCall = false;
  var missedUpdate = false;
  var DEBOUNCE_MS = 300;

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

  async function triggerSectionRefresh() {
    try {
      var comps = document.querySelectorAll('cart-items-component');
      var sectionIds = [];
      comps.forEach(function(c) { if (c.dataset.sectionId) sectionIds.push(c.dataset.sectionId); });
      if (sectionIds.length === 0) return;

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
    } catch(e) {}
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

  // Intercept /cart/add.js and convert to qty increment when variant already in cart.
  // This prevents Shopify from creating duplicate line items.
  async function interceptCartAdd(originalFetch, fetchArgs) {
    var body = fetchArgs[1] && fetchArgs[1].body;
    var variantId, quantity, sections;

    // Parse variant ID and sections from request body (FormData or JSON)
    if (body instanceof FormData) {
      variantId = body.get('id');
      quantity = parseInt(body.get('quantity')) || 1;
      sections = body.get('sections');
    } else if (typeof body === 'string') {
      try {
        var parsed = JSON.parse(body);
        variantId = String(parsed.id || (parsed.items && parsed.items[0] && parsed.items[0].id) || '');
        quantity = parsed.quantity || (parsed.items && parsed.items[0] && parsed.items[0].quantity) || 1;
        sections = parsed.sections;
      } catch(e) {}
    }

    if (!variantId) {
      // Can't parse — let original through
      return originalFetch.apply(window, fetchArgs).then(function(r) { scheduleUpdate(); return r; });
    }

    // Check if this variant already exists in the cart
    try {
      var cart = await getCart();
      var existingLine = null;
      for (var i = 0; i < cart.items.length; i++) {
        var item = cart.items[i];
        if (String(item.variant_id) === String(variantId) &&
            !(item.properties && item.properties._gift === 'true')) {
          existingLine = item;
          break;
        }
      }

      if (!existingLine) {
        // Not in cart — let original /cart/add.js through
        console.log('[cart-progress] Add interceptor: variant not in cart, passing through');
        return originalFetch.apply(window, fetchArgs).then(function(r) { scheduleUpdate(); return r; });
      }

      // Variant exists! Convert to /cart/change.js (qty increment)
      var newQty = existingLine.quantity + quantity;
      console.log('[cart-progress] Add interceptor: variant exists (qty ' + existingLine.quantity + '), converting to change.js (qty ' + newQty + ')');

      var changeBody = {
        id: existingLine.key,
        quantity: newQty
      };
      if (sections) changeBody.sections = sections;

      isOwnCartCall = true;
      var response = await originalFetch('/cart/change.js', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(changeBody)
      });
      isOwnCartCall = false;

      scheduleUpdate();
      return response;
    } catch(e) {
      // On error, fall through to original request
      console.error('[cart-progress] Add interceptor error:', e);
      isOwnCartCall = false;
      return originalFetch.apply(window, fetchArgs).then(function(r) { scheduleUpdate(); return r; });
    }
  }

  async function update() {
    if (isUpdating) { return; }
    isUpdating = true;
    try {
      var config = getConfig();
      if (!config || !config.giftVariant) return;

      var cart = await getCart();
      var total = calcSubtotal(cart.items, config.giftVariant);
      var hasGift = cart.items.some(function(item) {
        return String(item.variant_id) === String(config.giftVariant);
      });

      // --- ADD GIFT ---
      if (total >= config.gift && !hasGift) {
        showCartLoading();
        var res = await cartApiCall('/cart/add.js', {
          items: [{ id: parseInt(config.giftVariant, 10), quantity: 1, properties: { _gift: "true" } }]
        });
        if (res && res.ok) {
          await triggerSectionRefresh();
          showCartLoading();
          await new Promise(function(r) { setTimeout(r, 500); });
          hideCartLoading();
        } else {
          hideCartLoading();
        }
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
          showCartLoading();
          await cartApiCall('/cart/change.js', { id: giftItem.key, quantity: 0 });
          await triggerSectionRefresh();
          showCartLoading();
          await new Promise(function(r) { setTimeout(r, 500); });
          hideCartLoading();
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
      missedUpdate = true;
      return;
    }
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(update, DEBOUNCE_MS);
  }

  // Intercept fetch: convert /cart/add.js to qty increment when variant exists
  var originalFetch = window.fetch;
  window.fetch = function() {
    var args = arguments;
    var url = typeof args[0] === 'string' ? args[0] : '';

    // Intercept /cart/add.js to prevent duplicate line items
    if (!isOwnCartCall && url.indexOf('/cart/add.js') !== -1) {
      return interceptCartAdd(originalFetch, args);
    }

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
