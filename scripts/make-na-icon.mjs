#!/usr/bin/env node

// 生成 na 的项目图标：钠原子的电子排布图（K 层 2、L 层 8、M 层 1）。
// 只使用 Node 内置模块，输出固定内容，方便提交到仓库。
//
// 用法：
//   node scripts/make-na-icon.mjs [输出路径]
// 默认输出到 <项目根>/assets/na-icon.svg。

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [argument] = process.argv.slice(2);

if (argument === "-h" || argument === "--help") {
  console.log("用法：node scripts/make-na-icon.mjs [输出路径]");
  process.exit(0);
}

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SIZE = 512;
const CENTER = SIZE / 2;

const COLORS = {
  shell: "#475569",
  electron: "#7dd3fc",
};

// 每个电子层：半径、电子数、第一颗电子的角度。
// 角度以正右方为 0°，顺时针增加；L 层偏移半格，避免和最外层排成一条线。
const SHELLS = [
  { radius: 104, count: 2, start: -90 },
  { radius: 158, count: 8, start: -67.5 },
  { radius: 212, count: 1, start: -90 },
];

const ELECTRON_COUNT = SHELLS.reduce(
  (total, shell) => total + shell.count,
  0,
);

const round = (value) => {
  const result = Number(value.toFixed(2));
  return Object.is(result, -0) ? 0 : result;
};

const at = (radius, degrees) => {
  const radians = (degrees * Math.PI) / 180;
  return {
    x: round(CENTER + radius * Math.cos(radians)),
    y: round(CENTER + radius * Math.sin(radians)),
  };
};

const shellElement = ({ radius }) =>
  `<circle class="shell" cx="${CENTER}" cy="${CENTER}" r="${radius}" ` +
  `fill="none" stroke="${COLORS.shell}" stroke-width="3" />`;

const electronElement = (radius, degrees) => {
  const { x, y } = at(radius, degrees);

  return (
    `\n    <circle class="electron" cx="${x}" cy="${y}" r="10.5" ` +
    `fill="${COLORS.electron}" />`
  );
};

const electronsOf = ({ radius, count, start }) =>
  Array.from({ length: count }, (_, index) =>
    electronElement(radius, start + (360 / count) * index),
  ).join("");

// 不加文字标注：靠核 + 轨道 + 电子数辨认钠原子。
const nucleus =
  `<circle cx="${CENTER}" cy="${CENTER}" r="56" fill="url(#nucleus)" />`;

const body = [
  `<rect x="8" y="8" width="${SIZE - 16}" height="${SIZE - 16}" ` +
    `rx="112" fill="url(#bg)" stroke="#334155" stroke-opacity="0.6" ` +
    `stroke-width="2" />`,
  ...SHELLS.map(shellElement),
  ...SHELLS.map(electronsOf),
  nucleus,
].join("\n  ");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" ` +
  `height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}" role="img" ` +
  `aria-labelledby="na-icon-title">
  <title id="na-icon-title">na 图标：钠原子的电子排布（K 2、L 8、M 1）</title>
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#18233b" />
      <stop offset="100%" stop-color="#0b1220" />
    </linearGradient>
    <radialGradient id="nucleus" cx="38%" cy="32%" r="78%">
      <stop offset="0%" stop-color="#fb923c" />
      <stop offset="100%" stop-color="#dc2626" />
    </radialGradient>
  </defs>
  <!-- 由 scripts/make-na-icon.mjs 生成，请修改脚本后重新运行。 -->
  ${body}
</svg>
`;

const target = resolve(argument ?? join(ROOT, "assets", "na-icon.svg"));

await mkdir(dirname(target), { recursive: true });
await writeFile(target, svg, "utf8");

console.log(
  `已生成 ${target}（${Buffer.byteLength(svg, "utf8")} 字节，` +
    `${ELECTRON_COUNT} 个电子）`,
);