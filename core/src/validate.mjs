import Ajv2020 from 'ajv/dist/2020.js';
import { readFileSync } from 'node:fs';

const load = (name) =>
  JSON.parse(readFileSync(new URL(`../schemas/${name}.schema.json`, import.meta.url), 'utf-8'));

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validators = {
  factSheet: ajv.compile(load('fact-sheet')),
  brief: ajv.compile(load('brief')),
  listing: ajv.compile(load('listing')),
  report: ajv.compile(load('compliance-report')),
};

/** 结构校验：数据形状是否符合契约。返回 { ok, errors } */
export function validate(kind, data) {
  const fn = validators[kind];
  if (!fn) throw new Error(`未知契约类型：${kind}`);
  const ok = fn(data);
  return {
    ok,
    errors: ok ? [] : fn.errors.map((e) => `${e.instancePath || '/'} ${e.message}`),
  };
}

/**
 * 引用完整性校验：JSON Schema 表达不了"这个编号必须存在于另一份文档里"，在这里补上。
 * 返回错误信息数组，空数组表示通过。
 */
export function checkReferences({ factSheet, brief, listing }) {
  const errors = [];
  const ids = factSheet.facts.map((f) => f.id);
  const known = new Set(ids);

  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dup.length) errors.push(`事实编号重复：${[...new Set(dup)].join(', ')}`);

  const check = (where, factIds) => {
    for (const id of factIds) {
      if (!known.has(id)) errors.push(`${where} 引用了不存在的事实编号 ${id}`);
    }
  };

  factSheet.attributes.forEach((a, i) => check(`事实表 attributes[${i}]`, a.fact_ids));
  brief?.angles.forEach((a, i) => check(`简报 angles[${i}]`, a.fact_ids));
  if (listing) {
    listing.attributes.forEach((a, i) => check(`文案 attributes[${i}]`, a.fact_ids));
    listing.qa.forEach((q, i) => check(`文案 qa[${i}]`, q.fact_ids));
    listing.claims.forEach((c, i) => check(`文案 claims[${i}]`, c.fact_ids));
  }
  return errors;
}

/** 合规报告一致性：passed 必须等价于"没有 error 级问题" */
export function checkReport(report) {
  const hasError = report.issues.some((i) => i.severity === 'error');
  return report.passed === !hasError
    ? []
    : [`passed=${report.passed} 与 issues 不一致（存在 error 级问题：${hasError}）`];
}
