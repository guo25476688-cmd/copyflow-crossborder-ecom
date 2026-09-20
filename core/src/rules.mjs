import { readFileSync } from 'node:fs';

const load = (name) => JSON.parse(readFileSync(new URL(`../rules/${name}.json`, import.meta.url), 'utf-8'));
export const RULE_SETS = ['amazon-us', 'shopee-id'].map(load);

// ™ © ® 属于 Extended_Pictographic，但 Shopee 官方明确允许 ™，所以排除
const EMOJI = /(?![™©®])\p{Extended_Pictographic}/gu;
const rx = (p) => new RegExp(p, 'iu');
const clip = (s, n = 80) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** 把一份 Listing 摊平成 [{path, text, kind, group, groupPath}]，供规则按范围检查 */
export function extractFields(listing) {
  const out = [];
  const add = (path, text, kind, group = path, groupPath = path) => out.push({ path, text, kind, group, groupPath });
  const c = listing.content;
  if (listing.platform === 'amazon') {
    add('content/title', c.title, 'title');
    c.bullets.forEach((b, i) => {
      add(`content/bullets/${i}/heading`, b.heading, 'bullet', `bullet-${i}`, `content/bullets/${i}`);
      add(`content/bullets/${i}/text`, b.text, 'bullet', `bullet-${i}`, `content/bullets/${i}`);
    });
    add('content/description', c.description, 'description');
    (c.item_highlights || []).forEach((h, i) => add(`content/item_highlights/${i}`, h, 'highlights', 'highlights', 'content/item_highlights'));
  } else if (listing.platform === 'shopee') {
    add('content/title', c.title, 'title');
    add('content/highlight', c.highlight, 'highlight');
    c.features.forEach((f, i) => add(`content/features/${i}`, f, 'feature'));
    c.promo_tags.forEach((t, i) => add(`content/promo_tags/${i}`, t, 'promo'));
  }
  listing.attributes.forEach((a, i) => add(`attributes/${i}`, `${a.name}: ${a.value}`, 'attribute'));
  listing.qa.forEach((q, i) => add(`qa/${i}/answer`, q.answer, 'qa'));
  return out;
}

const inScope = (fields, scope) => (scope.includes('all') ? fields : fields.filter((f) => scope.includes(f.kind)));

// 依据等级决定严重程度：官方原文点名的短语/类别沿用规则自身等级；我推断的（derived）一律只给警告
const severityFor = (rule, basis) => (basis === 'derived' ? 'warning' : rule.severity);

const factsText = (fs) =>
  fs ? [...fs.facts.map((f) => f.statement), ...fs.attributes.map((a) => `${a.name} ${a.value}`)].join('\n') : '';

const SMALL_WORDS = new Set(['in', 'on', 'over', 'with', 'and', 'or', 'for', 'the', 'a', 'an', 'of', 'to', 'by', 'at', 'from']);
const UNIT_WORDS = new Set(['cm', 'mm', 'oz', 'in', 'kg', 'g', 'lb', 'lbs', 'ft', 'ml', 'l', 'inch', 'inches', 'x']);

const checks = {
  max_length(rule, ctx) {
    const fs = ctx.fields.filter((f) => f.kind === (rule.target === 'item_highlights' ? 'highlights' : rule.target));
    if (!fs.length) return [];
    const text = fs.map((f) => f.text).join(rule.joiner ?? ' ');
    return text.length > rule.max
      ? [{ severity: rule.severity, path: rule.target === 'item_highlights' ? 'content/item_highlights' : fs[0].path, evidence: `${clip(text)}（${text.length}/${rule.max}）` }]
      : [];
  },

  forbidden_patterns(rule, ctx) {
    const issues = [];
    for (const f of inScope(ctx.fields, rule.scope)) {
      for (const { pattern, basis } of rule.patterns) {
        const m = f.text.match(rx(pattern));
        if (m) issues.push({ severity: severityFor(rule, basis), path: f.path, evidence: clip(m[0]) });
      }
    }
    return issues;
  },

  forbidden_chars(rule, ctx) {
    const issues = [];
    for (const f of inScope(ctx.fields, rule.scope)) {
      const text = rule.ignore_brand && ctx.brand ? f.text.split(ctx.brand).join(' ') : f.text;
      const hit = [...new Set([...text].filter((ch) => rule.chars.includes(ch)))];
      if (hit.length) issues.push({ severity: rule.severity, path: f.path, evidence: hit.join(' ') });
    }
    return issues;
  },

  max_word_repeat(rule, ctx) {
    const issues = [];
    const allowed = new Set(rule.allowed_words);
    for (const f of inScope(ctx.fields, rule.scope)) {
      const counts = new Map();
      for (const w of f.text.toLowerCase().split(/[^\p{L}\p{N}']+/u)) {
        if (!w || !/\p{L}/u.test(w) || allowed.has(w)) continue;
        counts.set(w, (counts.get(w) || 0) + 1);
      }
      const over = [...counts].filter(([, n]) => n > rule.max);
      if (over.length) issues.push({ severity: rule.severity, path: f.path, evidence: over.map(([w, n]) => `${w}×${n}`).join('、') });
    }
    return issues;
  },

  title_case(rule, ctx) {
    const issues = [];
    for (const f of inScope(ctx.fields, rule.scope)) {
      const bad = f.text
        .split(/\s+/)
        .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
        .filter((w, i) => {
          if (!w || !/^\p{Ll}/u.test(w) || /\p{Lu}|\d/u.test(w)) return false;
          const lw = w.toLowerCase();
          return !(i > 0 && (SMALL_WORDS.has(lw) || UNIT_WORDS.has(lw)));
        });
      if (bad.length) issues.push({ severity: rule.severity, path: f.path, evidence: bad.join('、') });
    }
    return issues;
  },

  all_caps(rule, ctx) {
    const groups = new Map();
    for (const f of inScope(ctx.fields, rule.scope)) {
      const g = groups.get(f.group) || { path: f.groupPath, text: [] };
      g.text.push(f.text);
      groups.set(f.group, g);
    }
    const issues = [];
    for (const g of groups.values()) {
      const letters = g.text.join(' ').replace(/[^\p{L}]/gu, '');
      if (letters.length >= rule.min_letters && !/\p{Ll}/u.test(letters)) {
        issues.push({ severity: rule.severity, path: g.path, evidence: clip(g.text.join(' ')) });
      }
    }
    return issues;
  },

  non_latin_script(rule, ctx) {
    const issues = [];
    for (const f of inScope(ctx.fields, rule.scope)) {
      const hit = [...f.text].filter((ch) => /\p{L}/u.test(ch) && !/\p{Script=Latin}/u.test(ch));
      if (hit.length) issues.push({ severity: rule.severity, path: f.path, evidence: [...new Set(hit)].slice(0, 10).join('') });
    }
    return issues;
  },

  emoji(rule, ctx) {
    const issues = [];
    for (const f of inScope(ctx.fields, rule.scope)) {
      const hit = f.text.match(EMOJI);
      if (hit) issues.push({ severity: rule.severity, path: f.path, evidence: [...new Set(hit)].join(' ') });
    }
    return issues;
  },

  // 声称类：命中模式，且事实表里找不到对应依据时才报
  claim_needs_fact(rule, ctx) {
    const supported = rule.fact_patterns.some((p) => rx(p).test(ctx.facts));
    if (supported) return [];
    return checks.forbidden_patterns(rule, ctx);
  },
};

/** 对一份 Listing 跑对应平台×市场的规则集，返回符合 ComplianceReport 契约的报告 */
export function runRules({ listing, factSheet }) {
  const set = RULE_SETS.find((s) => s.platform === listing.platform && s.markets.includes(listing.market));
  if (!set) {
    return {
      passed: false,
      rule_set_version: 'none',
      issues: [{
        rule_id: 'meta.no-rule-set', severity: 'error', path: 'market', evidence: `${listing.platform}/${listing.market}`,
        fix_hint: '该平台与市场组合暂无经官方来源核实的规则集，无法校验，不能视为通过',
      }],
    };
  }
  const ctx = { fields: extractFields(listing), facts: factsText(factSheet), brand: factSheet?.product?.brand || null };
  const issues = [];
  for (const rule of set.rules) {
    for (const i of checks[rule.check](rule, ctx)) {
      issues.push({ rule_id: rule.id, severity: i.severity, path: i.path, evidence: i.evidence, fix_hint: rule.fix_hint, source: rule.source.url });
    }
  }
  // 去重降噪：同一规则在同一处已报错误，就不再重复报警告；被更强规则覆盖的提示性规则同理
  const suppressedBy = Object.fromEntries(set.rules.filter((r) => r.suppressed_by).map((r) => [r.id, r.suppressed_by]));
  const errorAt = (id, path) => issues.some((i) => i.rule_id === id && i.path === path && i.severity === 'error');
  const kept = issues.filter(
    (i) => !(i.severity === 'warning' && errorAt(i.rule_id, i.path)) && !(suppressedBy[i.rule_id] && errorAt(suppressedBy[i.rule_id], i.path)),
  );
  return { passed: !kept.some((i) => i.severity === 'error'), rule_set_version: `${set.id}@${set.version}`, issues: kept };
}

export const CHECK_TYPES = Object.keys(checks);
