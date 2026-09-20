import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runRules, RULE_SETS, CHECK_TYPES } from '../src/rules.mjs';
import { validate, checkReport } from '../src/validate.mjs';

const read = (p) => JSON.parse(readFileSync(new URL(`../examples/valid/${p}.json`, import.meta.url), 'utf-8'));
const factSheet = read('fact-sheet');
const amazon = () => structuredClone(read('listing-amazon'));
const shopee = () => structuredClone(read('listing-shopee'));
const tiktok = () => structuredClone(read('listing-tiktok'));

const ids = (report) => report.issues.map((i) => i.rule_id);
const has = (report, id, severity) => report.issues.some((i) => i.rule_id === id && (!severity || i.severity === severity));

// ---------- 规则集本身的完整性 ----------

test('规则集完整性：每条规则都有官方来源、查询日期、合法检查类型，id 唯一', () => {
  const allowed = { 'amazon-us': 'https://sellercentral.amazon.com/', 'shopee-id': 'https://seller.shopee.co.id/', 'tiktok-us': 'https://seller-us.tiktok.com/' };
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

test('合规样例：Amazon、Shopee、TikTok 的有效样例通过且无任何问题', () => {
  for (const [name, listing] of [['amazon', amazon()], ['shopee', shopee()], ['tiktok', tiktok()]]) {
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
  // 号码在句末、后面紧跟句号时也要抓到（此前的正则漏检）
  l.content.bullets[1].text = 'Questions? Call +1 415 555 0123.';
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

// ---------- TikTok Shop 美国站：每条规则都要能抓到违规 ----------

const tt = (mutate) => {
  const l = tiktok();
  mutate(l.content);
  return runRules({ listing: l, factSheet });
};

test('TikTok 标题：长度、品牌、首字母大写、特殊符号、重复词、罗列变体', () => {
  assert.ok(has(tt((c) => (c.title = `HoverGo ${'Wireless '.repeat(30)}Earbuds`)), 'tt.title.max-length', 'warning'));
  assert.ok(has(tt((c) => (c.title = 'HoverGo Earbuds')), 'tt.title.min-length', 'warning'));

  let r = tt((c) => (c.title = 'Wireless Earbuds with Active Noise Cancelling and Bluetooth 5.3'));
  assert.ok(has(r, 'tt.title.includes-brand', 'error'));
  assert.equal(r.passed, false);

  r = tt((c) => (c.title = 'HoverGo Pro wireless Earbuds with active Noise Cancelling'));
  assert.ok(has(r, 'tt.title.capitalization', 'error'));

  r = tt((c) => (c.title = 'HoverGo Pro Wireless Earbuds ~ Noise Cancelling $ Bluetooth #5.3'));
  assert.ok(has(r, 'tt.title.special-chars', 'warning'));
  assert.equal(r.passed, true, '特殊符号是官方建议，只给警告');

  assert.ok(has(tt((c) => (c.title = 'HoverGo Cotton Shirt, Soft Cotton Shirt, Cotton Shirt for Men')), 'tt.title.word-repeat', 'warning'));
  assert.ok(has(tt((c) => (c.title = 'HoverGo Pro Earbuds Case XXS-6XL All Sizes Available')), 'tt.title.variations-in-title', 'warning'));
});

test('TikTok 标题：介词与计量单位小写不误报，品牌大小写不敏感', () => {
  const r = tt((c) => (c.title = 'Hovergo Pro Wireless Earbuds with Case for Running, 10 cm Cable'));
  assert.ok(!has(r, 'tt.title.includes-brand'));
  assert.ok(!has(r, 'tt.title.capitalization'));
});

test('TikTok 全大写：标题、描述、要点都不允许，但缩写词不算', () => {
  assert.ok(has(tt((c) => (c.title = 'HOVERGO PRO WIRELESS EARBUDS')), 'tt.all-caps', 'error'));
  assert.ok(has(tt((c) => (c.description = c.description.toUpperCase())), 'tt.all-caps', 'error'));
  assert.ok(has(tt((c) => (c.bullets[0] = 'ACTIVE NOISE CANCELLING FOR COMMUTES')), 'tt.all-caps', 'error'));
  assert.ok(!has(tt((c) => (c.bullets[3] = 'Rated IPX5 for sweat and light rain.')), 'tt.all-caps'));
});

test('TikTok 禁止内容：主观评价、促销、站外信息、平台名', () => {
  assert.ok(has(tt((c) => (c.title += ' Best Seller')), 'tt.no-subjective', 'error'));
  assert.ok(has(tt((c) => (c.bullets[0] = 'Trending Item for commuters.')), 'tt.no-subjective', 'error'));
  assert.ok(has(tt((c) => (c.description += ' Enjoy 20% off today.')), 'tt.no-promotion', 'error'));
  assert.ok(has(tt((c) => (c.description += ' Visit https://myshop.example.com for more.')), 'tt.no-offplatform', 'error'));
  assert.ok(has(tt((c) => (c.description += ' Email help@myshop.com anytime.')), 'tt.no-offplatform', 'error'));
  assert.ok(has(tt((c) => (c.description += ' Scan the QR code to order.')), 'tt.no-offplatform', 'error'));
  assert.ok(has(tt((c) => (c.description += ' Loved on TikTok by thousands.')), 'tt.no-platform-refs', 'error'));
});

test('TikTok 推断类规则只给警告，不影响通过：热销词、限时、其他平台名、电话', () => {
  const r = tt((c) => (c.description += ' A hot item, limited-time, also sold on Amazon. Call 555 123 4567.'));
  for (const id of ['tt.no-subjective', 'tt.no-promotion', 'tt.no-platform-refs', 'tt.no-offplatform']) {
    assert.ok(has(r, id, 'warning'), id);
    assert.ok(!has(r, id, 'error'), id);
  }
});

test('TikTok 规格数字不被当成电话号码', () => {
  assert.ok(!has(tt((c) => (c.description += ' Model 2024 with 1080 mAh battery, 5.3 Bluetooth, 30 hours.')), 'tt.no-offplatform'));
});

test('TikTok 字母替换：西里尔混拉丁、符号替字母', () => {
  assert.ok(has(tt((c) => (c.title = 'HoverGo Pro Дpple Style Earbuds Case')), 'tt.no-lookalike-script', 'error'));
  assert.ok(has(tt((c) => (c.title = 'N!KE Style HoverGo Earbuds Case Cover')), 'tt.no-lookalike-symbols', 'error'));
});

test('TikTok 平替与对比：dupe/knock-off 报错，fake/replica 与对比短语只警告', () => {
  assert.ok(has(tt((c) => (c.description += ' A perfect AirPods dupe.')), 'tt.no-imitation', 'error'));
  assert.ok(has(tt((c) => (c.description += ' Not a knock-off.')), 'tt.no-imitation', 'error'));
  const r = tt((c) => (c.description += ' Made with fake leather. Sounds better than other brands.'));
  assert.ok(has(r, 'tt.no-imitation', 'warning') && !has(r, 'tt.no-imitation', 'error'));
  assert.ok(has(r, 'tt.no-comparison', 'warning'));
});

test('TikTok 夸大声称：官方点名的 before and after 报警告，绝对化词报警告', () => {
  const r = tt((c) => (c.description += ' The best earbuds, guaranteed, with before and after results.'));
  assert.ok(has(r, 'tt.claims.unproven', 'warning'));
  assert.equal(r.passed, true);
});

test('TikTok 疾病声称：治疗动词与疾病连用报错；单独出现不报', () => {
  assert.ok(has(tt((c) => (c.bullets[0] = 'Helps manage diabetes every day.')), 'tt.claim.disease', 'error'));
  assert.ok(has(tt((c) => (c.description += ' Clinically shown to cure depression.')), 'tt.claim.disease', 'error'));
  assert.ok(!has(tt((c) => (c.description += ' Comfortable for people with diabetes to wear.')), 'tt.claim.disease'));
  assert.ok(!has(tt((c) => (c.description += ' A great gift for anyone.')), 'tt.claim.disease'));
});

test('TikTok 原产地声称：事实表没有依据就报错，有依据就放行', () => {
  const l = tiktok();
  l.content.bullets[0] = 'Made in USA with care.';
  assert.ok(has(runRules({ listing: l, factSheet }), 'tt.claim.origin', 'error'));

  const withOrigin = structuredClone(factSheet);
  withOrigin.facts.push({ id: 'F5', statement: 'Made in USA', source: 'user_input', evidence: 'Made in USA' });
  assert.ok(!has(runRules({ listing: l, factSheet: withOrigin }), 'tt.claim.origin'));

  l.content.bullets[0] = 'Made in Vietnam with care.';
  assert.ok(has(runRules({ listing: l, factSheet }), 'tt.claim.origin', 'warning'));
});

test('TikTok 数字：英文数字词只给警告', () => {
  const r = tt((c) => (c.bullets[0] = 'Includes two ear tips and three cables.'));
  assert.ok(has(r, 'tt.numerals', 'warning'));
  assert.equal(r.passed, true);
});

test('TikTok 描述长度：不足 30 词报错，不足 500 字符警告，二者按描述+要点合计', () => {
  let r = tt((c) => {
    c.description = 'Nice earbuds for daily use.';
    c.bullets = ['Long battery life.'];
  });
  assert.ok(has(r, 'tt.description.min-words', 'error'));
  assert.ok(has(r, 'tt.description.min-chars', 'warning'));
  assert.equal(r.passed, false);

  // 词数够（>=30）但字符不到 500：只有警告
  r = tt((c) => {
    c.description = Array(31).fill('word').join(' ');
    c.bullets = ['Ok.', 'Ok.', 'Ok.'];
  });
  assert.ok(!has(r, 'tt.description.min-words'));
  assert.ok(has(r, 'tt.description.min-chars', 'warning'));
  assert.equal(r.passed, true);
});

test('TikTok 要点：数量 3-5、首字母大写、单位写全称', () => {
  assert.ok(has(tt((c) => (c.bullets = c.bullets.slice(0, 2))), 'tt.bullets.count', 'warning'));
  assert.ok(has(tt((c) => (c.bullets = [...c.bullets, 'Extra one here.', 'Extra two here.'])), 'tt.bullets.count', 'warning'));
  assert.ok(has(tt((c) => (c.bullets[1] = 'up to about 30 hours of battery life.')), 'tt.bullets.capital-start', 'error'));
  assert.ok(has(tt((c) => (c.bullets[1] = 'Charging cable is 30 cm long and the case weighs 45 g.')), 'tt.bullets.units-full-form', 'error'));
  const ok = tt((c) => (c.bullets[1] = 'Charging cable is 30 centimeters long.'));
  assert.ok(!has(ok, 'tt.bullets.units-full-form'));
  // 标题里恰恰相反：缩写不报错
  assert.ok(!has(tt((c) => (c.title = 'HoverGo Pro Wireless Earbuds with 30 cm Charging Cable')), 'tt.title.capitalization'));
});

test('TikTok 没有品牌信息时不检查标题含品牌', () => {
  const l = tiktok();
  const noBrand = structuredClone(factSheet);
  noBrand.product.brand = null;
  l.content.title = 'Wireless Earbuds with Active Noise Cancelling and Bluetooth 5.3';
  assert.ok(!has(runRules({ listing: l, factSheet: noBrand }), 'tt.title.includes-brand'));
});

test('TikTok 违规报告自身合法：引用官方来源，且自洽', () => {
  const r = tt((c) => (c.title = 'HOVERGO BEST SELLER 20% OFF'));
  assert.deepEqual(validate('report', r), { ok: true, errors: [] });
  assert.deepEqual(checkReport(r), []);
  assert.ok(r.issues.every((i) => i.source.startsWith('https://seller-us.tiktok.com/')));
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
