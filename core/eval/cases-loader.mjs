import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// dev：调提示词时反复使用的开发集；holdout：调提示词时没见过的留出集，只在定稿后跑一次
export const SETS = { dev: 'cases', holdout: 'holdout' };

export function loadCases(set = 'dev') {
  if (!SETS[set]) throw new Error(`未知用例集：${set}`);
  const dir = fileURLToPath(new URL(`./${SETS[set]}/`, import.meta.url));
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf-8')));
}

/** 评测输出目录属于哪个用例集：以 meta.json 记录为准，没有就当 dev */
export function detectSet(outDir) {
  const p = join(outDir, 'meta.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')).set || 'dev' : 'dev';
}
