import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runRules, RULE_SETS, CHECK_TYPES } from '../src/rules.mjs';
import { validate, checkReport } from '../src/validate.mjs';

const read = (p) => JSON.parse(readFileSync(new URL(`../examples/valid/${p}.json`, import.meta.url), 'utf-8'));
const factSheet = read('fact-sheet');
const amazon = () => structuredClone(read('listing-amazon'));
const shopee = () => structuredClone(read('listing-shopee'));

const ids = (report) => report.issues.map((i) => i.rule_id);
const has = (report, id, severity) => report.issues.some((i) => i.rule_id === id && (!severity || i.severity === severity));

// ---------- 规则集本身的完整性 ----------

test('规则集完整性：每条规则都有官方来源、查询日期、合法检查类型，id 唯一', () => {
  const allowed = { 'amazon-us': 'https://sellercentral.amazon.com/', 'shopee-id': 'https://seller.shopee.co.id/' };
  for (const set of RULE_SETS) {
    assert.ok(set.unverified.length > 0, `${set.id} 必须如实列出未核实项`);
    const seen = new Set();
    for (const r of set.rules) {
      assert.ok(!seen.has(r.id), `重复 id ${r.id}`);
      seen.add(r.id);
      assert.ok(CHECK_TYPES.includes(r.check), `${r.id} 检查类型未知`);
      assert.ok(r.source.url.startsWith(allowed[set.id]), `${r.id} 来源不是官方域名`);
      assert.equal(r.source.retrieved_at, set.retrieved_at);
      assert.ok(['error', 'warning'].includes(r.severity));
      for (const p of r.patterns || []) {
        assert.ok(['official_example', 'official_category', 'derived'].includes(p.basis), `${r.id} 依据等级非法`);
        assert.doesNotThrow(() => new RegExp(p.pattern, 'iu'), `${r.id}: ${p.pattern}`);
      }
    }
  }
});

// ---------- 合规样例应当零问题 ----------

test('合规样例：Amazon 与 Shopee 的有效样例通过且无任何问题', () => {
  for (const [name, listing] of [['amazon', amazon()], ['shopee', shopee()]]) {
    const r = runRules({ listing, factSheet });
    assert.deepEqual(r.issues, [], `${name} 样例不应有问题`);
    assert.equal(r.passed, true);
  }
});

test('报告自身符合 ComplianceReport 契约且自洽', () => {
  const l = amazon();
  l.content.title = 'BEST SELLER!!! ' + l.content.title;
  const r = runRules({ listing: l, factSheet });
  assert.deepEqual(validate('report', r), { ok: true, errors: [] });
  assert.deepEqual(checkReport(r), []);
  assert.equal(r.passed, false);
});

// ---------- Amazon：每条规则都要能抓到违规 ----------

test('Amazon 标题：超过 75 字符、含 ! 、同词出现三次、促销语、全大写', () => {
  let l = amazon();
  l.content.title = 'HoverGo Pro Wireless Earbuds Active Noise Cancelling Bluetooth 5.3 Headphones for Commuting Workout';
  assert.ok(has(runRules({ listing: l, factSheet }), 'amz.title.max-length', 'error'));

  l = amazon();
  l.content.title = 'HoverGo Pro Earbuds, Noise Cancelling!';
  assert.ok(has(runRules({ listing: l, factSheet }), 'amz.title.special-chars', 'error'));

  l = amazon();
  l.content.title = 'Baby Boy Outfits Baby Boy Winter Clothes Baby Boy Suit';
  assert.ok(has(runRules({ listing: l, factSheet }), 'amz.title.word-repeat', 'error'));

  l = amazon();
  l.content.title = 'HoverGo Pro Earbuds Free Shipping';
  assert.ok(has(runRules({ listing: l, factSheet }), 'amz.title.promotional', 'error'));

  l = amazon();
  l.content.title = 'HOVERGO PRO WIRELESS EARBUDS';
  assert.ok(has(runRules({ listing: l, factSheet }), 'amz.all-caps', 'error'));
});

test('Amazon 大写：只有小标题大写不违规（官方只禁整段全大写），整条卖点全大写才违规', () => {
  let l = amazon();
  l.content.bullets[0].heading = 'ACTIVE NOISE CANCELLING';
  assert.ok(!has(runRules({ listing: l, factSheet }), 'amz.all-caps'));
  l.content.bullets[0] = { heading: 'ACTIVE NOISE CANCELLING', text: 'CUTS DOWN BACKGROUND NOISE ON THE TRAIN' };
  const r = runRules({ listing: l, factSheet });
  assert.ok(has(r, 'amz.all-caps', 'error'));
  assert.equal(r.issues.find((i) => i.rule_id === 'amz.all-caps').path, 'content/bullets/0');
});

test('Amazon 标题：首字母大写只给警告，不影响通过；介词与计量单位小写不误报', () => {
  let l = amazon();
  l.content.title = 'HoverGo Pro wireless earbuds';
  let r = runRules({ listing: l, factSheet });
  assert.ok(has(r, 'amz.title.capitalization', 'warning'));
  assert.equal(r.passed, true);

  l = amazon();
  l.content.title = 'Cotton Towels with Hooks, 24 x 48 inches';
  assert.ok(!has(runRules({ listing: l, factSheet }), 'amz.title.capitalization'));
});

test('Amazon Item highlights：合计超过 125 字符', () => {
  const l = amazon();
  l.content.item_highlights = ['x'.repeat(60), 'y'.repeat(60), 'z'.repeat(10)];
  assert.ok(has(runRules({ listing: l, factSheet }), 'amz.highlights.max-length', 'error'));
});

test('Amazon 禁止内容：网址、邮箱、价格、免运费、HTML、FSA/HSA', () => {
  const cases = [
    ['amz.no-contact-url', 'Visit https://example.com for more'],
    ['amz.no-contact-url', 'Contact us at seller@example.com'],
    ['amz.no-price-availability-shipping', 'Only $19 today with free shipping'],
    ['amz.no-html', 'Great <b>sound</b> quality'],
    ['amz.restricted-phrases', 'FSA/HSA eligible product'],
  ];
  for (const [id, text] of cases) {
    const l = amazon();
    l.content.bullets[2].text = text;
    assert.ok(has(runRules({ listing: l, factSheet }), id, 'error'), `${id} 应报错：${text}`);
  }
  const l = amazon();
  l.content.description = 'Line one<br>Line two';
  assert.ok(!has(runRules({ listing: l, factSheet }), 'amz.no-html'), '描述里的 <br> 官方允许');
});

test('Amazon 电话号码检测：不误伤规格数字', () => {
  const l = amazon();
  l.content.bullets[1].text = 'Up to 30 hours of playtime, 24 x 48 inches case, 1500 mAh battery, Bluetooth 5.3';
  assert.ok(!has(runRules({ listing: l, factSheet }), 'amz.no-contact-url'));
  l.content.bullets[1].text = 'Call us at +1 (415) 555-0123 today';
  assert.ok(has(runRules({ listing: l, factSheet }), 'amz.no-contact-url', 'error'));
});

test('Amazon 声称：无依据的认证/最高级/疾病/环保/可验证声称', () => {
  const cases = [
    ['amz.claim.false-certification', 'CE certified for peace of mind'],
    ['amz.claim.unqualified-superlative', 'The best earbuds for commuting'],
    ['amz.claim.unqualified-superlative', 'Satisfaction guaranteed'],
    ['amz.claim.disease', 'Helps reduce symptoms of depression'],
    ['amz.claim.environmental', 'An eco-friendly choice'],
    ['amz.claim.verifiable', 'Battery lasts 10 years'],
  ];
  for (const [id, text] of cases) {
    const l = amazon();
    l.content.bullets[4].text = text;
    assert.ok(has(runRules({ listing: l, factSheet }), id, 'error'), `${id} 应报错：${text}`);
  }
});

test('Amazon 声称：事实表里有依据就不再报（认证类）', () => {
  const l = amazon();
  l.content.bullets[4].text = 'CE certified for peace of mind';
  const withProof = structuredClone(factSheet);
  withProof.facts.push({ id: 'F5', statement: '已获得 CE 认证（证书由卖家提供）', source: 'user_input', evidence: 'CE 认证证书' });
  assert.ok(has(runRules({ listing: l, factSheet }), 'amz.claim.false-certification'));
  assert.ok(!has(runRules({ listing: l, factSheet: withProof }), 'amz.claim.false-certification'));
});

test('Amazon 推断类规则只给警告：#1、促销措辞', () => {
  const l = amazon();
  l.content.bullets[3].text = 'The #1 pick, now on sale';
  const r = runRules({ listing: l, factSheet });
  assert.ok(has(r, 'amz.claim.unqualified-superlative', 'warning'));
  assert.ok(has(r, 'amz.no-promotional-copy', 'warning'));
  assert.equal(r.passed, true);
});

test('Amazon 疾病词：单独出现只警告；与治疗动词连用才报错', () => {
  const l = amazon();
  l.content.bullets[4].text = 'Not intended for people with diabetes';
  let r = runRules({ listing: l, factSheet });
  assert.ok(has(r, 'amz.claim.disease-term', 'warning'));
  assert.ok(!has(r, 'amz.claim.disease'));
  l.content.bullets[4].text = 'Helps prevent diabetes';
  r = runRules({ listing: l, factSheet });
  assert.ok(has(r, 'amz.claim.disease', 'error'));
});

// ---------- Shopee ----------

test('Shopee：非拉丁字母报错；emoji 只给警告且不影响通过；网址报错', () => {
  let l = shopee();
  l.content.features[0] = '主动降噪 nyaman di jalan';
  assert.ok(has(runRules({ listing: l, factSheet }), 'shp.script.non-latin', 'error'));

  l = shopee();
  l.content.highlight = '🔥 Noise cancelling aktif';
  const r = runRules({ listing: l, factSheet });
  assert.ok(has(r, 'shp.symbols.emoji', 'warning'));
  assert.equal(r.passed, true);

  l = shopee();
  l.content.features[1] = 'Order lewat www.tokoku.com ya';
  assert.ok(has(runRules({ listing: l, factSheet }), 'shp.no-contact-url', 'error'));
});

test('Shopee：官方允许的 ™ 与常见标点不被当作 emoji', () => {
  const l = shopee();
  l.content.title = 'HoverGo™ Pro Earphone (Bluetooth 5.3) - Rp125.000 & Bonus';
  assert.deepEqual(runRules({ listing: l, factSheet }).issues, []);
});

// ---------- 覆盖不到时不能假装通过 ----------

test('没有规则集的平台/市场组合：报错并标明无法校验，不能算通过', () => {
  const l = amazon();
  l.market = 'en-GB';
  const r = runRules({ listing: l, factSheet });
  assert.equal(r.passed, false);
  assert.deepEqual(ids(r), ['meta.no-rule-set']);
});

test('降噪：同一规则同一处已报错误则不重复报警告；疾病词警告被疾病功效错误覆盖', () => {
  const l = amazon();
  l.content.bullets[1].text = 'CE certified for peace of mind';
  let r = runRules({ listing: l, factSheet });
  assert.equal(r.issues.filter((i) => i.rule_id === 'amz.claim.false-certification').length, 1);

  l.content.bullets[4].text = 'Helps prevent diabetes';
  r = runRules({ listing: l, factSheet });
  assert.ok(has(r, 'amz.claim.disease', 'error'));
  assert.ok(!has(r, 'amz.claim.disease-term'));
});
