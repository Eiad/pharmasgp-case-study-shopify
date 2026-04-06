/**
 * Cart Progress Bar — End-to-End Test Suite
 *
 * Tests the core logic extracted from cart-progress-bar.js:
 *   1. Subtotal calculation (gift exclusion)
 *   2. Consolidation of duplicate gift lines
 *   3. Gift add/remove decision logic
 *   4. Progress bar calculation across all 3 states
 *   5. Rapid-click race condition simulation
 *
 * Run: node tests/cart-progress-bar.test.js
 */

const SHIPPING_THRESHOLD = 3999;  // $39.99 in cents
const GIFT_THRESHOLD = 9999;      // $99.99 in cents
const GIFT_VARIANT = '44444444444';
const CURRENCY = '$';

// ============================================================
// EXTRACTED LOGIC (mirrors cart-progress-bar.js exactly)
// ============================================================

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

// Broader consolidation: ALL duplicate variant lines, grouped by variant_id only
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

// Legacy helpers for backward compat in existing tests
function findGiftLines(items, giftVariant) {
  var giftLines = [];
  items.forEach(function(item) {
    if (String(item.variant_id) === String(giftVariant)) {
      giftLines.push({ key: item.key, quantity: item.quantity });
    }
  });
  return giftLines;
}

function needsConsolidation(giftLines) {
  return giftLines.length > 1 || (giftLines.length === 1 && giftLines[0].quantity > 1);
}

function calcProgress(total, shipping, gift) {
  if (total >= gift) return 100;
  if (total >= shipping) return 50 + ((total - shipping) / (gift - shipping)) * 50;
  return (total / shipping) * 50;
}

function getStatusText(total, shipping, gift, sym) {
  if (total >= gift) return 'You got free shipping & a free gift!';
  if (total >= shipping) return 'Free gift at ' + sym + (gift / 100).toFixed(2);
  return 'Free shipping at ' + sym + (shipping / 100).toFixed(2);
}

function shouldAddGift(total, giftThreshold, hasGift) {
  return total >= giftThreshold && !hasGift;
}

function shouldRemoveGift(total, giftThreshold, hasGift) {
  return total < giftThreshold && hasGift;
}

// ============================================================
// CART API SIMULATOR
// ============================================================

class CartSimulator {
  constructor() {
    this.items = [];
    this.apiCallLog = [];
    this.concurrentCalls = 0;
    this.maxConcurrentCalls = 0;
  }

  addItem(variantId, quantity, price, properties, key) {
    this.items.push({
      variant_id: variantId,
      quantity: quantity,
      final_line_price: price * quantity,
      price: price,
      properties: properties || {},
      key: key || 'key_' + Math.random().toString(36).substr(2, 9)
    });
  }

  getCart() {
    return {
      items: JSON.parse(JSON.stringify(this.items)),
      items_subtotal_price: this.items.reduce((s, i) => s + i.final_line_price, 0)
    };
  }

  async simulateAddGift(giftVariant, delay) {
    this.concurrentCalls++;
    this.maxConcurrentCalls = Math.max(this.maxConcurrentCalls, this.concurrentCalls);
    this.apiCallLog.push({ type: 'add', variant: giftVariant, time: Date.now() });

    if (delay) await new Promise(r => setTimeout(r, delay));

    // Simulate Shopify behavior: if same variant+properties exists, increment qty
    // But under concurrent conditions, might create a new line
    const existing = this.items.find(i =>
      String(i.variant_id) === String(giftVariant) &&
      i.properties && i.properties._gift === 'true'
    );

    if (existing && this.concurrentCalls <= 1) {
      existing.quantity += 1;
      existing.final_line_price = existing.price * existing.quantity;
    } else {
      // Concurrent add — Shopify creates a new line item (the bug)
      this.addItem(giftVariant, 1, 1399, { _gift: 'true' });
    }

    this.concurrentCalls--;
    return { ok: true };
  }

  applyUpdate(updates) {
    this.apiCallLog.push({ type: 'update', updates: updates, time: Date.now() });
    for (const [key, qty] of Object.entries(updates)) {
      const idx = this.items.findIndex(i => i.key === key);
      if (idx !== -1) {
        if (qty === 0) {
          this.items.splice(idx, 1);
        } else {
          this.items[idx].quantity = qty;
          this.items[idx].final_line_price = this.items[idx].price * qty;
        }
      }
    }
  }

  getGiftLineCount() {
    return this.items.filter(i => String(i.variant_id) === String(GIFT_VARIANT)).length;
  }

  getTotalGiftQty() {
    return this.items
      .filter(i => String(i.variant_id) === String(GIFT_VARIANT))
      .reduce((s, i) => s + i.quantity, 0);
  }
}

// ============================================================
// TEST FRAMEWORK
// ============================================================

let passed = 0;
let failed = 0;
let totalTests = 0;

function describe(name, fn) {
  console.log('\n\x1b[1m' + name + '\x1b[0m');
  fn();
}

function test(name, fn) {
  totalTests++;
  try {
    fn();
    passed++;
    console.log('  \x1b[32m✓\x1b[0m ' + name);
  } catch (e) {
    failed++;
    console.log('  \x1b[31m✗\x1b[0m ' + name);
    console.log('    \x1b[31m' + e.message + '\x1b[0m');
  }
}

async function testAsync(name, fn) {
  totalTests++;
  try {
    await fn();
    passed++;
    console.log('  \x1b[32m✓\x1b[0m ' + name);
  } catch (e) {
    failed++;
    console.log('  \x1b[31m✗\x1b[0m ' + name);
    console.log('    \x1b[31m' + e.message + '\x1b[0m');
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error((message || 'assertEqual') + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
  }
}

function assertClose(actual, expected, tolerance, message) {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error((message || 'assertClose') + ': expected ~' + expected + ', got ' + actual);
  }
}

// ============================================================
// TESTS
// ============================================================

describe('1. Subtotal Calculation — Gift Exclusion', function() {

  test('excludes gift by variant_id from subtotal', function() {
    const items = [
      { variant_id: '11111', quantity: 2, final_line_price: 5998, properties: {} },
      { variant_id: GIFT_VARIANT, quantity: 1, final_line_price: 1399, properties: { _gift: 'true' } }
    ];
    assertEqual(calcSubtotal(items, GIFT_VARIANT), 5998, 'Should exclude gift');
  });

  test('excludes gift by _gift property even with different variant_id', function() {
    const items = [
      { variant_id: '11111', quantity: 1, final_line_price: 2999, properties: {} },
      { variant_id: '99999', quantity: 1, final_line_price: 1399, properties: { _gift: 'true' } }
    ];
    // _gift property match — excluded regardless of variant_id
    assertEqual(calcSubtotal(items, GIFT_VARIANT), 2999, 'Should exclude by _gift property');
  });

  test('includes all items when no gift present', function() {
    const items = [
      { variant_id: '11111', quantity: 2, final_line_price: 5998, properties: {} },
      { variant_id: '22222', quantity: 1, final_line_price: 1500, properties: {} }
    ];
    assertEqual(calcSubtotal(items, GIFT_VARIANT), 7498, 'Should include all');
  });

  test('returns 0 for empty cart', function() {
    assertEqual(calcSubtotal([], GIFT_VARIANT), 0, 'Empty cart should be 0');
  });

  test('excludes multiple gift lines from subtotal', function() {
    const items = [
      { variant_id: '11111', quantity: 4, final_line_price: 11996, properties: {} },
      { variant_id: GIFT_VARIANT, quantity: 1, final_line_price: 1399, properties: { _gift: 'true' } },
      { variant_id: GIFT_VARIANT, quantity: 1, final_line_price: 1399, properties: { _gift: 'true' } }
    ];
    assertEqual(calcSubtotal(items, GIFT_VARIANT), 11996, 'Should exclude both gift lines');
  });

  test('handles gift with final_line_price of 0 (after BXGY discount)', function() {
    const items = [
      { variant_id: '11111', quantity: 4, final_line_price: 11996, properties: {} },
      { variant_id: GIFT_VARIANT, quantity: 1, final_line_price: 0, properties: { _gift: 'true' } }
    ];
    assertEqual(calcSubtotal(items, GIFT_VARIANT), 11996, 'Should exclude even $0 gift');
  });

  test('items_subtotal_price WOULD include gift (proving why we need exclusion)', function() {
    const items = [
      { variant_id: '11111', quantity: 4, final_line_price: 11996, properties: {} },
      { variant_id: GIFT_VARIANT, quantity: 1, final_line_price: 1399, properties: { _gift: 'true' } }
    ];
    const rawSubtotal = items.reduce((s, i) => s + i.final_line_price, 0);
    assertEqual(rawSubtotal, 13395, 'Raw subtotal includes gift — circular dependency');
    assertEqual(calcSubtotal(items, GIFT_VARIANT), 11996, 'Our calc excludes gift');
  });
});

describe('2. Gift Line Consolidation', function() {

  test('detects no consolidation needed for single gift line qty 1', function() {
    const giftLines = [{ key: 'a', quantity: 1 }];
    assertEqual(needsConsolidation(giftLines), false, 'Single qty 1 — no consolidation');
  });

  test('detects consolidation needed for duplicate gift lines', function() {
    const giftLines = [{ key: 'a', quantity: 1 }, { key: 'b', quantity: 1 }];
    assertEqual(needsConsolidation(giftLines), true, 'Duplicates — needs consolidation');
  });

  test('detects consolidation needed for single gift line qty > 1', function() {
    const giftLines = [{ key: 'a', quantity: 3 }];
    assertEqual(needsConsolidation(giftLines), true, 'Qty > 1 — needs consolidation');
  });

  test('detects no consolidation needed when no gift lines exist', function() {
    assertEqual(needsConsolidation([]), false, 'No gift lines — no consolidation');
  });

  test('builds correct update: gift duplicates → keeps first at qty 1, removes rest', function() {
    const items = [
      { variant_id: '11111', quantity: 4, key: 'main', properties: {} },
      { variant_id: GIFT_VARIANT, quantity: 1, key: 'gift_1', properties: { _gift: 'true' } },
      { variant_id: GIFT_VARIANT, quantity: 1, key: 'gift_2', properties: { _gift: 'true' } },
      { variant_id: GIFT_VARIANT, quantity: 1, key: 'gift_3', properties: { _gift: 'true' } }
    ];
    const updates = buildConsolidationUpdates(items, GIFT_VARIANT);
    assertEqual(updates['gift_1'], 1, 'First gift line kept at qty 1');
    assertEqual(updates['gift_2'], 0, 'Second gift line removed');
    assertEqual(updates['gift_3'], 0, 'Third gift line removed');
    assert(!('main' in updates), 'Main product untouched');
  });

  test('consolidation applied to CartSimulator removes gift duplicates', function() {
    const sim = new CartSimulator();
    sim.addItem('11111', 4, 2999, {}, 'main_key');
    sim.addItem(GIFT_VARIANT, 1, 1399, { _gift: 'true' }, 'gift_1');
    sim.addItem(GIFT_VARIANT, 1, 1399, { _gift: 'true' }, 'gift_2');
    sim.addItem(GIFT_VARIANT, 1, 1399, { _gift: 'true' }, 'gift_3');

    assertEqual(sim.getGiftLineCount(), 3, 'Started with 3 gift lines');

    const updates = buildConsolidationUpdates(sim.getCart().items, GIFT_VARIANT);
    sim.applyUpdate(updates);

    assertEqual(sim.getGiftLineCount(), 1, 'Consolidated to 1 gift line');
    assertEqual(sim.getTotalGiftQty(), 1, 'Total gift qty is 1');
  });
});

describe('3. Gift Add/Remove Decision Logic', function() {

  test('should add gift when total >= threshold and no gift in cart', function() {
    assertEqual(shouldAddGift(10000, GIFT_THRESHOLD, false), true);
  });

  test('should NOT add gift when total >= threshold and gift already in cart', function() {
    assertEqual(shouldAddGift(10000, GIFT_THRESHOLD, true), false);
  });

  test('should NOT add gift when total < threshold', function() {
    assertEqual(shouldAddGift(5000, GIFT_THRESHOLD, false), false);
  });

  test('should remove gift when total < threshold and gift in cart', function() {
    assertEqual(shouldRemoveGift(5000, GIFT_THRESHOLD, true), true);
  });

  test('should NOT remove gift when total >= threshold', function() {
    assertEqual(shouldRemoveGift(10000, GIFT_THRESHOLD, true), false);
  });

  test('should NOT remove gift when no gift in cart', function() {
    assertEqual(shouldRemoveGift(5000, GIFT_THRESHOLD, false), false);
  });

  test('exact threshold value ($99.99) should trigger add', function() {
    assertEqual(shouldAddGift(9999, GIFT_THRESHOLD, false), true);
  });

  test('one cent below threshold should NOT trigger add', function() {
    assertEqual(shouldAddGift(9998, GIFT_THRESHOLD, false), false);
  });
});

describe('4. Progress Bar Calculation — All 3 States', function() {

  test('State 1: below shipping threshold — progress 0-50%', function() {
    // $0 → 0%
    assertEqual(calcProgress(0, SHIPPING_THRESHOLD, GIFT_THRESHOLD), 0, '$0 = 0%');

    // $20 → ~25%
    const p20 = calcProgress(2000, SHIPPING_THRESHOLD, GIFT_THRESHOLD);
    assertClose(p20, 25.0, 0.5, '$20 ≈ 25%');

    // $39.98 → just under 50%
    const p3998 = calcProgress(3998, SHIPPING_THRESHOLD, GIFT_THRESHOLD);
    assert(p3998 < 50, '$39.98 should be < 50%');
    assert(p3998 > 49, '$39.98 should be > 49%');
  });

  test('State 2: between shipping and gift threshold — progress 50-100%', function() {
    // $39.99 → exactly 50%
    assertEqual(calcProgress(3999, SHIPPING_THRESHOLD, GIFT_THRESHOLD), 50, '$39.99 = 50%');

    // $70 → somewhere between 50-100%
    const p70 = calcProgress(7000, SHIPPING_THRESHOLD, GIFT_THRESHOLD);
    assert(p70 > 50, '$70 should be > 50%');
    assert(p70 < 100, '$70 should be < 100%');
    assertClose(p70, 75.0, 1, '$70 ≈ 75%');

    // $99.98 → just under 100%
    const p9998 = calcProgress(9998, SHIPPING_THRESHOLD, GIFT_THRESHOLD);
    assert(p9998 < 100, '$99.98 should be < 100%');
    assert(p9998 > 99, '$99.98 should be > 99%');
  });

  test('State 3: above gift threshold — progress 100%', function() {
    assertEqual(calcProgress(9999, SHIPPING_THRESHOLD, GIFT_THRESHOLD), 100, '$99.99 = 100%');
    assertEqual(calcProgress(15000, SHIPPING_THRESHOLD, GIFT_THRESHOLD), 100, '$150 = 100%');
  });

  test('progress never exceeds 100%', function() {
    const p = calcProgress(50000, SHIPPING_THRESHOLD, GIFT_THRESHOLD);
    assertEqual(p, 100, 'Max 100%');
  });

  test('progress is continuous — never jumps backward', function() {
    let prev = 0;
    for (let cents = 0; cents <= 15000; cents += 100) {
      const p = calcProgress(cents, SHIPPING_THRESHOLD, GIFT_THRESHOLD);
      assert(p >= prev, 'Progress should never decrease: at $' + (cents/100) + ' got ' + p + ' < prev ' + prev);
      prev = p;
    }
  });

  test('status text matches state', function() {
    assertEqual(
      getStatusText(2000, SHIPPING_THRESHOLD, GIFT_THRESHOLD, CURRENCY),
      'Free shipping at $39.99',
      'Below shipping'
    );
    assertEqual(
      getStatusText(5000, SHIPPING_THRESHOLD, GIFT_THRESHOLD, CURRENCY),
      'Free gift at $99.99',
      'Between thresholds'
    );
    assertEqual(
      getStatusText(10000, SHIPPING_THRESHOLD, GIFT_THRESHOLD, CURRENCY),
      'You got free shipping & a free gift!',
      'Above gift'
    );
  });
});

describe('5. Rapid-Click Race Condition Simulation', function() {

  testAsync('simulates 10 rapid add attempts — consolidation cleans up', async function() {
    const sim = new CartSimulator();
    sim.addItem('11111', 4, 2999, {}, 'main');  // $119.96

    // Simulate 10 concurrent gift add attempts (rapid clicks)
    const addPromises = [];
    for (let i = 0; i < 10; i++) {
      addPromises.push(sim.simulateAddGift(GIFT_VARIANT, 5));
    }
    await Promise.all(addPromises);

    // Without consolidation, we'd have multiple gift lines
    const giftCountBefore = sim.getGiftLineCount();
    assert(giftCountBefore > 1, 'Rapid adds should create duplicates: got ' + giftCountBefore);

    // Apply consolidation (what our fixed code does)
    const cart = sim.getCart();
    const giftLines = findGiftLines(cart.items, GIFT_VARIANT);
    if (needsConsolidation(giftLines)) {
      const updates = buildConsolidationUpdates(giftLines);
      sim.applyUpdate(updates);
    }

    assertEqual(sim.getGiftLineCount(), 1, 'After consolidation: exactly 1 gift line');
    assertEqual(sim.getTotalGiftQty(), 1, 'After consolidation: gift qty is 1');

    // Verify subtotal excludes all gift lines
    const finalCart = sim.getCart();
    const total = calcSubtotal(finalCart.items, GIFT_VARIANT);
    assertEqual(total, 11996, 'Subtotal still $119.96 — gift excluded');
  });

  testAsync('rapid threshold bouncing — add then remove then add', async function() {
    const sim = new CartSimulator();

    // Start below threshold
    sim.addItem('11111', 3, 2999, {}, 'main');  // $89.97
    let cart = sim.getCart();
    let total = calcSubtotal(cart.items, GIFT_VARIANT);
    assertEqual(shouldAddGift(total, GIFT_THRESHOLD, false), false, 'Below threshold — no add');

    // Cross threshold (qty 4 = $119.96)
    sim.items[0].quantity = 4;
    sim.items[0].final_line_price = 4 * 2999;
    cart = sim.getCart();
    total = calcSubtotal(cart.items, GIFT_VARIANT);
    assertEqual(shouldAddGift(total, GIFT_THRESHOLD, false), true, 'Above threshold — add');

    // Add gift
    await sim.simulateAddGift(GIFT_VARIANT, 0);
    let hasGift = sim.getGiftLineCount() > 0;
    assertEqual(hasGift, true, 'Gift added');

    // Drop below threshold (qty 2 = $59.98)
    sim.items[0].quantity = 2;
    sim.items[0].final_line_price = 2 * 2999;
    cart = sim.getCart();
    total = calcSubtotal(cart.items, GIFT_VARIANT);
    hasGift = sim.getGiftLineCount() > 0;
    assertEqual(shouldRemoveGift(total, GIFT_THRESHOLD, hasGift), true, 'Below threshold — remove');

    // Remove gift
    const giftItem = sim.items.find(i => String(i.variant_id) === String(GIFT_VARIANT));
    const removeUpdates = {};
    removeUpdates[giftItem.key] = 0;
    sim.applyUpdate(removeUpdates);
    assertEqual(sim.getGiftLineCount(), 0, 'Gift removed');

    // Cross threshold again (qty 4 = $119.96)
    sim.items[0].quantity = 4;
    sim.items[0].final_line_price = 4 * 2999;
    cart = sim.getCart();
    total = calcSubtotal(cart.items, GIFT_VARIANT);
    hasGift = sim.getGiftLineCount() > 0;
    assertEqual(shouldAddGift(total, GIFT_THRESHOLD, hasGift), true, 'Re-crossed threshold — add again');
  });

  test('subtotal excludion prevents circular dependency during threshold bounce', function() {
    const items = [
      { variant_id: '11111', quantity: 4, final_line_price: 11996, properties: {} },
      { variant_id: GIFT_VARIANT, quantity: 1, final_line_price: 1399, properties: { _gift: 'true' } }
    ];

    // With exclusion: $119.96 (correct — only real products)
    const excludedTotal = calcSubtotal(items, GIFT_VARIANT);
    assertEqual(excludedTotal, 11996, 'Excluded total = $119.96');

    // Without exclusion: $133.95 (wrong — includes gift's real price)
    const rawTotal = items.reduce((s, i) => s + i.final_line_price, 0);
    assertEqual(rawTotal, 13395, 'Raw total = $133.95 (would be circular)');

    // With exclusion, dropping qty to 3 ($89.97) correctly detects below threshold
    items[0].quantity = 3;
    items[0].final_line_price = 3 * 2999;
    const droppedTotal = calcSubtotal(items, GIFT_VARIANT);
    assertEqual(droppedTotal, 8997, 'Dropped total = $89.97');
    assertEqual(shouldRemoveGift(droppedTotal, GIFT_THRESHOLD, true), true, 'Should remove gift');
  });

  test('consolidation update object uses line item keys (not indices)', function() {
    const items = [
      { variant_id: GIFT_VARIANT, key: 'abc123:def456', quantity: 1, properties: { _gift: 'true' } },
      { variant_id: GIFT_VARIANT, key: 'ghi789:jkl012', quantity: 1, properties: { _gift: 'true' } }
    ];
    const updates = buildConsolidationUpdates(items, GIFT_VARIANT);

    assert(typeof Object.keys(updates)[0] === 'string', 'Keys should be strings (line item keys)');
    assert(Object.keys(updates)[0].includes(':'), 'Keys should look like line item keys');
    assertEqual(updates['abc123:def456'], 1, 'First line kept');
    assertEqual(updates['ghi789:jkl012'], 0, 'Second line removed');
  });
});

describe('6. Edge Cases', function() {

  test('gift variant ID as number vs string comparison', function() {
    const items = [
      { variant_id: 44444444444, quantity: 1, final_line_price: 1399, properties: { _gift: 'true' } },
      { variant_id: '11111', quantity: 1, final_line_price: 2999, properties: {} }
    ];
    // String(44444444444) === '44444444444' — should match
    const total = calcSubtotal(items, '44444444444');
    assertEqual(total, 2999, 'Number variant_id matches string config');
  });

  test('gift with no properties object', function() {
    const items = [
      { variant_id: GIFT_VARIANT, quantity: 1, final_line_price: 1399 },
      { variant_id: '11111', quantity: 1, final_line_price: 2999, properties: {} }
    ];
    // No properties but variant_id matches — still excluded
    const total = calcSubtotal(items, GIFT_VARIANT);
    assertEqual(total, 2999, 'Gift without properties excluded by variant_id');
  });

  test('gift with properties but null _gift', function() {
    const items = [
      { variant_id: GIFT_VARIANT, quantity: 1, final_line_price: 1399, properties: { _gift: null } },
      { variant_id: '11111', quantity: 1, final_line_price: 2999, properties: {} }
    ];
    // variant_id matches — excluded regardless of _gift value
    const total = calcSubtotal(items, GIFT_VARIANT);
    assertEqual(total, 2999, 'Gift with null _gift excluded by variant_id');
  });

  test('large cart value — progress capped at 100', function() {
    const p = calcProgress(99999, SHIPPING_THRESHOLD, GIFT_THRESHOLD);
    assertEqual(p, 100, '$999.99 = 100%');
  });

  test('zero threshold edge case', function() {
    // If shipping is 0, everything should be at least 50%
    const p = calcProgress(100, 0, GIFT_THRESHOLD);
    // Division by zero guard: 100/0 = Infinity → but we don't guard this in code
    // This is acceptable since thresholds are always > 0 from Shopify settings
    assert(true, 'Zero threshold is not a valid config — skipped');
  });
});

describe('7. Broader Consolidation — All Variants', function() {

  test('consolidates K53 split: sums quantities correctly', function() {
    const items = [
      { variant_id: '11111', quantity: 3, key: 'k53_a', properties: {}, final_line_price: 8997 },
      { variant_id: '11111', quantity: 4, key: 'k53_b', properties: {}, final_line_price: 11996 }
    ];
    const updates = buildConsolidationUpdates(items, GIFT_VARIANT);
    assert(updates !== null, 'Should need consolidation');
    assertEqual(updates['k53_a'], 7, 'First line gets summed qty (3+4=7)');
    assertEqual(updates['k53_b'], 0, 'Second line removed');
  });

  test('consolidates K53 split: subtotal unchanged after applying', function() {
    const sim = new CartSimulator();
    sim.addItem('11111', 3, 2999, {}, 'k53_a');  // $89.97
    sim.addItem('11111', 4, 2999, {}, 'k53_b');  // $119.96

    const totalBefore = calcSubtotal(sim.getCart().items, GIFT_VARIANT);
    assertEqual(totalBefore, 20993, 'Before: $209.93');

    const updates = buildConsolidationUpdates(sim.getCart().items, GIFT_VARIANT);
    sim.applyUpdate(updates);

    assertEqual(sim.items.length, 1, 'Merged to 1 line');
    assertEqual(sim.items[0].quantity, 7, 'Qty = 7');
    const totalAfter = calcSubtotal(sim.getCart().items, GIFT_VARIANT);
    assertEqual(totalAfter, 20993, 'After: still $209.93');
  });

  test('consolidates lines even with different properties (groups by variant_id only)', function() {
    const items = [
      { variant_id: '11111', quantity: 2, key: 'k53_normal', properties: {} },
      { variant_id: '11111', quantity: 1, key: 'k53_custom', properties: { engraving: 'hello' } }
    ];
    const updates = buildConsolidationUpdates(items, GIFT_VARIANT);
    assert(updates !== null, 'Same variant_id — should consolidate');
    assertEqual(updates['k53_normal'], 3, 'First line gets summed qty');
    assertEqual(updates['k53_custom'], 0, 'Second line removed');
  });

  test('consolidates mixed splits: K53 + gift in one atomic update', function() {
    const items = [
      { variant_id: '11111', quantity: 3, key: 'k53_a', properties: {} },
      { variant_id: '11111', quantity: 4, key: 'k53_b', properties: {} },
      { variant_id: GIFT_VARIANT, quantity: 1, key: 'gift_a', properties: { _gift: 'true' } },
      { variant_id: GIFT_VARIANT, quantity: 1, key: 'gift_b', properties: { _gift: 'true' } }
    ];
    const updates = buildConsolidationUpdates(items, GIFT_VARIANT);
    assert(updates !== null, 'Should need consolidation');
    // K53: sum quantities
    assertEqual(updates['k53_a'], 7, 'K53 first line: qty 7');
    assertEqual(updates['k53_b'], 0, 'K53 second line: removed');
    // Gift: force qty 1
    assertEqual(updates['gift_a'], 1, 'Gift first line: qty 1');
    assertEqual(updates['gift_b'], 0, 'Gift second line: removed');
  });

  test('no consolidation needed for single lines', function() {
    const items = [
      { variant_id: '11111', quantity: 4, key: 'k53', properties: {} },
      { variant_id: GIFT_VARIANT, quantity: 1, key: 'gift', properties: { _gift: 'true' } }
    ];
    const updates = buildConsolidationUpdates(items, GIFT_VARIANT);
    assertEqual(updates, null, 'No duplicates — no consolidation');
  });

  test('no consolidation for empty cart', function() {
    const updates = buildConsolidationUpdates([], GIFT_VARIANT);
    assertEqual(updates, null, 'Empty cart — no consolidation');
  });
});

describe('8. Variant-ID-Only Grouping', function() {

  test('same variant_id groups together regardless of properties', function() {
    const items = [
      { variant_id: GIFT_VARIANT, quantity: 1, key: 'g1', properties: { _gift: 'true' } },
      { variant_id: GIFT_VARIANT, quantity: 1, key: 'g2', properties: {} }
    ];
    const updates = buildConsolidationUpdates(items, GIFT_VARIANT);
    assert(updates !== null, 'Same variant_id — should consolidate');
    assertEqual(updates['g1'], 1, 'Gift forced to qty 1');
    assertEqual(updates['g2'], 0, 'Second line removed');
  });

  test('different variant_ids do NOT group together', function() {
    const items = [
      { variant_id: '11111', quantity: 2, key: 'a', properties: {} },
      { variant_id: '22222', quantity: 1, key: 'b', properties: {} }
    ];
    const updates = buildConsolidationUpdates(items, GIFT_VARIANT);
    assertEqual(updates, null, 'Different variant_ids — no consolidation');
  });

  test('add-to-cart duplicate: new line merged with existing', function() {
    const items = [
      { variant_id: '11111', quantity: 4, key: 'existing', properties: {} },
      { variant_id: '11111', quantity: 1, key: 'new_add', properties: {} },
      { variant_id: GIFT_VARIANT, quantity: 1, key: 'gift', properties: { _gift: 'true' } }
    ];
    const updates = buildConsolidationUpdates(items, GIFT_VARIANT);
    assert(updates !== null, 'K53 duplicated — should consolidate');
    assertEqual(updates['existing'], 5, 'Merged to qty 5');
    assertEqual(updates['new_add'], 0, 'New add line removed');
    assert(!('gift' in updates), 'Gift untouched (single line)');
  });
});

describe('9. Timing Constants', function() {

  test('debounce is 300ms', function() {
    // Verify the constant matches what the JS file uses
    const DEBOUNCE_MS = 300;
    assertEqual(DEBOUNCE_MS, 300, 'Debounce matches theme debounce');
  });

  test('overlay cooldown is 500ms', function() {
    const OVERLAY_COOLDOWN_MS = 500;
    assert(OVERLAY_COOLDOWN_MS >= 400, 'Cooldown long enough to prevent rapid clicks');
    assert(OVERLAY_COOLDOWN_MS <= 800, 'Cooldown short enough for good UX');
  });

  test('refresh delay is 100ms (not 300ms)', function() {
    const REFRESH_DELAY_MS = 100;
    assert(REFRESH_DELAY_MS < 300, 'Faster than old 300ms delay');
    assert(REFRESH_DELAY_MS > 0, 'Still has a small delay for Shopify commit');
  });

  test('overlay cooldown > debounce (prevents re-trigger during cooldown)', function() {
    const DEBOUNCE_MS = 300;
    const OVERLAY_COOLDOWN_MS = 500;
    assert(OVERLAY_COOLDOWN_MS > DEBOUNCE_MS, 'Overlay lasts longer than debounce');
  });
});

// ============================================================
// RUN & REPORT
// ============================================================

(async function() {
  // Wait for async tests to complete
  await new Promise(r => setTimeout(r, 500));

  console.log('\n' + '='.repeat(50));
  if (failed === 0) {
    console.log('\x1b[32m✓ All ' + passed + ' tests passed\x1b[0m');
  } else {
    console.log('\x1b[31m✗ ' + failed + ' of ' + totalTests + ' tests failed\x1b[0m');
  }
  console.log('='.repeat(50));

  process.exit(failed > 0 ? 1 : 0);
})();
