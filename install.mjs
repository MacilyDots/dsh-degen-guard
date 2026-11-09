/* 把 dsh-degen-guard 装进指定 DSH profile：
 *   1. package.json 的 dependencies 加 file: 依赖（幂等）
 *   2. dsh.profile.bundles 加插件名（幂等）
 *   3. node_modules/<name> 用 junction 指向本仓库目录
 *      —— 用 junction 而不是 pnpm 的复制，这样改源码立即生效，不必再同步副本。
 *
 * 写 JSON 一律 UTF-8 无 BOM（DSH 的 dsh-app-boot 用 JSON.parse 读，带 BOM 会启动失败）。
 *
 * 用法：
 *   node install.mjs                  # 装进 %DSH_HOME%\profiles\desktop
 *   node install.mjs web              # 装进指定 profile（可给多个）
 *   node install.mjs my-profile  # 也可以直接给 profile 目录
 */
import { copyFileSync, existsSync, lstatSync, readFileSync, rmdirSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_NAME = "dsh-degen-guard";

/** 本仓库目录就是插件目录：从脚本自身位置推导，不写死任何本机路径。 */
const PLUGIN_SRC = dirname(fileURLToPath(import.meta.url));
const DEP_SPEC = "file:" + PLUGIN_SRC.replace(/\\/g, "/");

const DSH_HOME = process.env.DSH_HOME || join(homedir(), ".dsh");

/** 参数给 profile 名（相对 %DSH_HOME%\profiles）或 profile 绝对路径；默认 desktop。 */
const args = process.argv.slice(2);
const profiles = (args.length > 0 ? args : ["desktop"]).map((t) => (isAbsolute(t) ? t : join(DSH_HOME, "profiles", t)));

if (!existsSync(join(PLUGIN_SRC, "package.json"))) throw new Error("plugin source looks wrong: " + PLUGIN_SRC);

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const report = [];

for (const profile of profiles) {
  const pkgPath = join(profile, "package.json");
  if (!existsSync(pkgPath)) {
    report.push({ profile, skipped: "no package.json" });
    continue;
  }

  const raw = readFileSync(pkgPath, "utf8");
  if (raw.charCodeAt(0) === 0xfeff) throw new Error("refusing to rewrite BOM-prefixed file: " + pkgPath);

  const pkg = JSON.parse(raw);
  const before = JSON.stringify(pkg.dependencies?.[PLUGIN_NAME] ?? null);
  pkg.dependencies = pkg.dependencies ?? {};
  pkg.dependencies[PLUGIN_NAME] = DEP_SPEC;

  pkg.dsh = pkg.dsh ?? {};
  pkg.dsh.profile = pkg.dsh.profile ?? {};
  pkg.dsh.profile.bundles = pkg.dsh.profile.bundles ?? [];
  const hadBundle = pkg.dsh.profile.bundles.includes(PLUGIN_NAME);
  if (!hadBundle) pkg.dsh.profile.bundles.push(PLUGIN_NAME);

  const backup = pkgPath + ".bak-degen-guard-" + stamp;
  copyFileSync(pkgPath, backup);
  const out = JSON.stringify(pkg, null, 2) + "\n";
  writeFileSync(pkgPath, out, "utf8");

  const check = readFileSync(pkgPath, "utf8");
  if (check.charCodeAt(0) === 0xfeff) throw new Error("BOM written: " + pkgPath);
  JSON.parse(check);

  const link = join(profile, "node_modules", PLUGIN_NAME);
  const existing = lstatSync(link, { throwIfNoEntry: false });
  let linkAction = "created";
  if (existing) {
    // 只删链接本身：junction 用 rmdir，普通目录/文件才需要更多处理。
    if (existing.isSymbolicLink() || existing.isDirectory()) {
      rmdirSync(link);
      linkAction = "relinked";
    } else {
      throw new Error("unexpected non-directory at " + link);
    }
  }
  symlinkSync(PLUGIN_SRC, link, "junction");

  report.push({
    profile,
    depBefore: before,
    depAfter: DEP_SPEC,
    bundleAdded: !hadBundle,
    backup,
    link: linkAction
  });
}

console.log(JSON.stringify(report, null, 2));
