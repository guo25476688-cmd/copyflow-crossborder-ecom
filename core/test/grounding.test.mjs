import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { numbersIn, isSupported, supportNumbers, unsupportedNumbers, checkGrounding, resolvePath } from '../src/grounding.mjs';
import { validate, checkReport } from '../src/validate.mjs';

const read = (p) => JSON.parse(readFileSync(new URL(`../examples/valid/${p}.json`, import.meta.url), 'utf-8'));
const factSheet = read('fact-sheet');
const listing = (name) => structuredClone(read(`listing-${name}`));
const check = (l, fs = factSheet) => checkGrounding({ factSheet: fs, listing: l });
const has = (r, id, severity) => r.issues.some((i) => i.rule_id === id && (!severity || i.severity === severity));
const vals = (text) => numbersIn(text).map((n) => n.value);

// ---------- 数字提取 ----------

test('数字提取：阿拉伯数字、小数、千分位（含印尼语 2.000）、规格里的字母不影响', () => {
  assert.deepEqual(vals('Bluetooth 5.3, IPX5, up to 30 hours'), [5.3, 5, 30]);
  assert.deepEqual(vals('Rp 150.000 dan 2.000 mAh, 1,500 mAh'), [150000, 2000, 1500]);
  assert.deepEqual(vals('kapasitas 0,5 liter'), [0.5]);
});

test('数字提取：中文数字只在后面跟着量词时才算（三档色温、二十四小时），一键、统一不算', () => {
  assert.deepEqual(vals('三档色温'), [3]);
  assert.deepEqual(vals('二十四小时 一百二十克 十二个月'), [24, 120, 12]);
  assert.deepEqual(vals('一键 统一 唯一'), []);
});

test('数字提取：“一个”是不定冠词用法（a/an），不算数量声称；“两个/三个”等真实计数仍要提取', () => {
  assert.deepEqual(vals('给买家一个可参考的尺寸信息'), []);
  assert.deepEqual(vals('这款产品有一个亮点'), []);
  assert.deepEqual(vals('两个模式，三个档位，一个开关').sort(), [2, 3]);
  assert.deepEqual(vals('保修一年，容量一升'), [1], '“一”配其他量词仍是真实数量，只有“一个”是例外');
});

test('数字提取：英文与印尼语数字词；twenty-four 只算 24，不再重复算 4；one 只在跟着时间单位时算', () => {
  assert.deepEqual(vals('twenty-four hours'), [24]);
  assert.deepEqual(vals('three modes and a two-year warranty').sort(), [2, 3]);
  assert.deepEqual(vals('one charge, no one'), []);
  assert.deepEqual(vals('one-year warranty'), [1]);
  assert.deepEqual(vals('garansi dua tahun, tiga mode'), [2, 3]);
  assert.deepEqual(vals('everyone owns phones'), [], '词内片段不算');
});

test('数字提取：紧跟其后的单位被识别，mAh 与 mL 不会被当成 m', () => {
  const u = (t) => numbersIn(t).map((n) => n.unit);
  assert.deepEqual(u('30 cm, 1.5kg, 500 mL, 20℃, 68°F, 11.8 inches, 12 fl oz'), ['cm', 'kg', 'ml', 'c', 'f', 'in', 'floz']);
  assert.deepEqual(u('1500 mAh, 30 hours, 9W'), [null, null, null]);
});

// ---------- 有依据吗：数字与单位换算 ----------

const supportOf = (text) => supportNumbers([{ id: 'F1', statement: text, evidence: text }]);

test('单位换算：事实是公制、文案写英制是正常的，四舍五入到 0/1/2 位都放行', () => {
  const s = supportOf('长30cm');
  assert.deepEqual(unsupportedNumbers('11.8 inches long', s), []);
  assert.deepEqual(unsupportedNumbers('about 12 inches long', s), []);
  assert.deepEqual(unsupportedNumbers('11.81 inches', s), []);
  assert.deepEqual(unsupportedNumbers('11.9 inches', s), [11.9], '不是换算结果就是编造');
});

test('单位换算：反方向（印尼站要写回公制）、温度、重量也放行', () => {
  assert.deepEqual(unsupportedNumbers('30 cm', supportOf('长12英寸')), []);
  assert.deepEqual(unsupportedNumbers('68°F', supportOf('耐温20℃')), []);
  assert.deepEqual(unsupportedNumbers('55 lbs', supportOf('承重25kg')), []);
});

test('单位换算必须单位成对：不同类的单位、没有单位的数字，不能靠乘系数撞上编造的数', () => {
  assert.deepEqual(unsupportedNumbers('11.8 lbs', supportOf('长30cm')), [11.8], 'cm 换不成 lbs');
  // 60cm × 0.3937 = 23.6 ≈ 24：没有 inches 单位的 “24 hours” 不能借此过关
  assert.deepEqual(unsupportedNumbers('24 hours', supportOf('长60cm')), [24]);
  assert.deepEqual(unsupportedNumbers('24 inches', supportOf('长60cm')), [], '同样的数，带上 inches 才是合理换算');
});

test('中文事实撑得住英文文案里的数字：三档色温 → three / 3 modes，功率 9W', () => {
  const s = supportOf('三档色温 功率9W');
  assert.deepEqual(unsupportedNumbers('Three color temperature modes and 9W power', s), []);
  assert.deepEqual(unsupportedNumbers('3 color modes', s), []);
  assert.deepEqual(unsupportedNumbers('12W power', s), [12]);
});

test('isSupported：完全相等直接通过', () => {
  assert.equal(isSupported({ value: 30, unit: null }, [{ value: 30, unit: 'cm' }]), true);
  assert.equal(isSupported({ value: 31, unit: null }, [{ value: 30, unit: 'cm' }]), false);
});

// ---------- 合规示例应当零问题 ----------

test('合规样例：三个平台的有效样例在依据检查下零问题，报告自身合法', () => {
  for (const name of ['amazon', 'shopee', 'tiktok']) {
    const r = check(listing(name));
    assert.deepEqual(r.issues, [], name);
    assert.equal(r.passed, true);
    assert.deepEqual(validate('report', r), { ok: true, errors: [] });
    assert.deepEqual(checkReport(r), []);
  }
});

// ---------- 卖点位置 ----------

test('卖点位置：path 不存在、指向的不是文本、原文不在该位置，都报错', () => {
  let l = listing('amazon');
  l.claims[0].path = 'content/bullets/9/text';
  assert.ok(has(check(l), 'ground.claim-path-missing', 'error'));

  l = listing('amazon');
  l.claims[0].path = 'content/bullets/0';
  assert.ok(has(check(l), 'ground.claim-path-missing', 'error'), '指向对象而不是文本');

  l = listing('amazon');
  l.claims[0].text = 'Cuts background noise by 99%';
  assert.ok(has(check(l), 'ground.claim-text-not-at-path', 'error'));

  l = listing('amazon');
  l.claims[0].path = 'content/bullets/1/text'; // 原文在 bullet 0，声明在 bullet 1
  assert.ok(has(check(l), 'ground.claim-text-not-at-path', 'error'));
});

test('卖点位置：大小写和空白差异不算不一致；路径可以带前导斜杠', () => {
  const l = listing('amazon');
  l.claims[0].text = '  CUTS   down background noise ';
  assert.deepEqual(check(l).issues, []);
  assert.equal(resolvePath(l, '/content/bullets/0/heading'), 'Active Noise Cancelling');
  assert.equal(resolvePath(l, 'content/nope'), undefined);
});

test('没有声明任何卖点依据：报错', () => {
  const l = listing('amazon');
  l.claims = [];
  assert.ok(has(check(l), 'ground.no-claims', 'error'));
});

// ---------- 数字有依据 ----------

test('卖点里的数字必须出自所引事实：把 30 小时改成 40 小时、引错事实都报错', () => {
  let l = listing('amazon');
  l.content.bullets[1].text = 'The charging case extends total battery life to about 40 hours, so a full week of commuting needs far fewer charges.';
  l.claims[1].text = 'about 40 hours';
  const r = check(l);
  assert.ok(has(r, 'ground.claim-number-unsupported', 'error'));
  assert.ok(has(r, 'ground.text-number-unsupported', 'error'), '正文里的 40 在事实表任何地方都没有');

  // 数字在事实表里存在，但不是这条卖点所引的事实（F3 的 30 被写成了引用 F1）
  l = listing('amazon');
  l.claims[1].fact_ids = ['F1'];
  const r2 = check(l);
  assert.ok(has(r2, 'ground.claim-number-unsupported', 'error'));
  assert.ok(!has(r2, 'ground.text-number-unsupported'), '30 在事实表里是有的，只是引错了事实');
});

test('属性与问答里的数字必须出自它引用的事实', () => {
  let l = listing('amazon');
  l.attributes[1].value = 'Up to 40 hours with charging case';
  assert.ok(has(check(l), 'ground.attribute-number-unsupported', 'error'));

  l = listing('amazon');
  l.qa[1].answer = 'Up to about 30 hours in total, and it charges fully in 2 hours.';
  assert.ok(has(check(l), 'ground.qa-number-unsupported', 'error'), '2 小时充满是编的');

  l = listing('amazon');
  l.qa[1].fact_ids = ['F1']; // 30 存在于 F3，不在 F1
  assert.ok(has(check(l), 'ground.qa-number-unsupported', 'error'));
});

test('正文夹带没人声明过的数字：质保、年份、数字词都抓', () => {
  for (const text of ['Backed by a 24 month warranty.', 'Includes a two-year warranty.', 'The 2026 upgraded model.', 'Ships in 48 hours.']) {
    const l = listing('tiktok');
    l.content.bullets[3] = `${text} Rated IPX5.`;
    const r = check(l);
    assert.ok(has(r, 'ground.text-number-unsupported', 'error'), text);
    assert.equal(r.passed, false);
  }
});

test('正文里的英制换算与数字词不误报：30cm 的线写成 11.8 inches，三档写成 three modes', () => {
  const fs = structuredClone(factSheet);
  fs.facts.push({ id: 'F5', statement: '线长30厘米，三档色温', source: 'user_input', evidence: '线长30厘米，三档色温' });
  const l = listing('tiktok');
  l.content.bullets[3] = 'Rated IPX5, with an 11.8 inches cable and three color temperature modes.';
  assert.ok(!has(check(l, fs), 'ground.text-number-unsupported'));
  assert.ok(has(check(l, factSheet), 'ground.text-number-unsupported', 'error'), '没有对应事实时同一句会报错');
});

test('产品名里的数字算有依据（型号 Pro 2、5G 等）', () => {
  const fs = structuredClone(factSheet);
  fs.product.name = 'HoverGo Pro 2 无线耳机';
  const l = listing('tiktok');
  l.content.bullets[3] = 'The Pro 2 is rated IPX5.';
  assert.ok(!has(check(l, fs), 'ground.text-number-unsupported'));
});

// ---------- 语言与字符 ----------

test('拉丁字母市场里出现中文（漏译）：报错并指出位置；品牌里的中文除外', () => {
  let l = listing('amazon');
  l.content.bullets[2].text = 'Bluetooth 5.3 keeps a steady 连接 with your phone.';
  let r = check(l);
  assert.ok(has(r, 'ground.foreign-script', 'error'));
  assert.equal(r.issues.find((i) => i.rule_id === 'ground.foreign-script').path, 'content/bullets/2/text');

  l = listing('shopee');
  l.content.features[0] = '主动降噪 untuk perjalanan';
  assert.ok(has(check(l), 'ground.foreign-script', 'error'));

  const fs = structuredClone(factSheet);
  fs.product.brand = '悦听';
  l = listing('tiktok');
  l.content.title = '悦听 HoverGo Pro Wireless Earbuds with Active Noise Cancelling, Bluetooth 5.3';
  assert.ok(!has(check(l, fs), 'ground.foreign-script'));
  assert.ok(has(check(l, factSheet), 'ground.foreign-script', 'error'));
});

test('买家问题里的中文也抓；单位符号 µ 与 Ω 不算串味', () => {
  let l = listing('amazon');
  l.qa[0].question = '这个耳机有降噪吗？';
  assert.ok(has(check(l), 'ground.foreign-script', 'error'));

  l = listing('tiktok');
  l.content.bullets[3] = 'Rated IPX5, 32 Ω impedance is not stated but 5 µm is a unit symbol.';
  assert.ok(!has(check(l), 'ground.foreign-script'));
});

test('全角标点只给警告，不影响通过', () => {
  const l = listing('tiktok');
  l.content.bullets[0] = 'Active noise cancelling helps quiet background sound，on trains and in offices.';
  l.claims[0].text = 'Active noise cancelling helps quiet background sound';
  const r = check(l);
  assert.ok(has(r, 'ground.fullwidth-punctuation', 'warning'));
  assert.equal(r.passed, true);
});

// ---------- 每行有声明依据 ----------

test('要点、亮点、促销标签没有对应 claims：给警告并指出是哪一行，不影响通过', () => {
  let l = listing('amazon');
  l.claims = l.claims.filter((c) => !c.path.startsWith('content/bullets/4'));
  let r = check(l);
  assert.deepEqual(r.issues.map((i) => [i.rule_id, i.severity, i.path]), [['ground.line-without-claim', 'warning', 'content/bullets/4']]);
  assert.equal(r.passed, true);

  l = listing('shopee');
  l.content.promo_tags = ['Ready Stock'];
  r = check(l);
  assert.ok(r.issues.some((i) => i.rule_id === 'ground.line-without-claim' && i.path === 'content/promo_tags/0'));
});

test('Amazon 一条要点的小标题和正文共用一条声明；TikTok 的要点直接声明', () => {
  assert.deepEqual(check(listing('amazon')).issues.filter((i) => i.rule_id === 'ground.line-without-claim'), []);
  const l = listing('tiktok');
  l.claims = l.claims.filter((c) => c.path !== 'content/bullets/2');
  assert.deepEqual(check(l).issues.map((i) => i.path), ['content/bullets/2']);
});

// ---------- 结构与引用 ----------

test('结构不合法：只报 ground.schema，不继续往下查', () => {
  const l = listing('tiktok');
  delete l.claims;
  const r = check(l);
  assert.ok(r.issues.length > 0 && r.issues.every((i) => i.rule_id === 'ground.schema'));
  assert.equal(r.passed, false);
});

test('引用了不存在的事实编号：报 ground.reference', () => {
  const l = listing('tiktok');
  l.claims[0].fact_ids = ['F99'];
  assert.ok(has(check(l), 'ground.reference', 'error'));
});

test('多个问题会同时报出，不是遇到第一个就停', () => {
  const l = listing('amazon');
  l.claims[0].path = 'content/nope';
  l.attributes[1].value = 'Up to 40 hours';
  l.content.bullets[2].text = 'Bluetooth 5.3 连接';
  const ids = new Set(check(l).issues.map((i) => i.rule_id));
  for (const id of ['ground.claim-path-missing', 'ground.attribute-number-unsupported', 'ground.foreign-script']) assert.ok(ids.has(id), id);
});
