#!/usr/bin/env node
// @ts-check

/**
  This script is used to publish Ember's type definitions. The basic workflow
  is:

  1. Run `tsc` against the Ember packages which make up its public API, with the
     output being `/types/stable`.

  2. Wrap each emitted module in a `declare module` statement. This requires
     replacing all relative imports with absolute imports and removing all
     `declare` statements from the body of the module.

     While doing so, keep track of the full list of emitted modules for the sake
     of step (3).

  3. Check that each module emitted is included in `types/stable/index.d.ts`, if
     and only if it also appears in a list of stable types modules defined in
     this script, so that they all "show up" to end users. That list will
     eventually be the list of *all* modules, but this allows us to publish
     iteratively as we gain confidence in the stability of the types.

  This is *not* an optimal long-term publishing strategy. We would prefer to
  generate per-package roll-ups, using a Rollup plugin or some such, but we are
  currently blocked on a number of internal circular dependencies as well as the
  difficulty of avoiding multiple definitions of the same types reused across
  many rollups.

  @packageDocumentation
 */

import glob from 'glob';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import * as parser from 'recast/parsers/babel-ts.js';
import {
  isClassDeclaration,
  isStringLiteral,
  isVariableDeclaration,
  isTSDeclareFunction,
  isTSEnumDeclaration,
} from '@babel/types';
import { builders as b, visit } from 'ast-types';
import { parse, print } from 'recast';

/**
  Modules we know we are not ready to expose yet, mostly because they do not
  have enough annotations on their internals to make the generated types clear
  about what is public and what is private.

  Notably, the modules will still be published, but they won't be visible to
  consumers because the only way they *become* visible is by being included in
  the set of type-only side effect imports, which excludes exactly these
  modules.
 */
const PREVIEW_MODULES = [
  '@ember/canary-features/index.d.ts',
  '@ember/component/helper.d.ts',
  '@ember/component/index.d.ts',
  '@ember/component/template-only.d.ts',
  '@ember/deprecated-features/index.d.ts',
  '@ember/destroyable/index.d.ts',
  '@ember/helper/index.d.ts',
  '@ember/instrumentation/index.d.ts',
  '@ember/modifier/index.d.ts',
  '@ember/polyfills/index.d.ts',
  '@ember/polyfills/lib/assign.d.ts',
  '@ember/renderer/index.d.ts',
  '@ember/runloop/index.d.ts',
  '@ember/service/index.d.ts',
  '@ember/string/index.d.ts',
  '@ember/string/lib/string_registry.d.ts',
  '@ember/template-compilation/index.d.ts',
  '@ember/template-factory/index.d.ts',
  '@ember/template/index.d.ts',
  '@ember/test/adapter.d.ts',
  '@ember/test/index.d.ts',
  '@ember/utils/index.d.ts',
  '@ember/utils/lib/compare.d.ts',
  '@ember/utils/lib/is_blank.d.ts',
  '@ember/utils/lib/is_empty.d.ts',
  '@ember/utils/lib/is_none.d.ts',
  '@ember/utils/lib/is_present.d.ts',
  '@ember/utils/lib/is-equal.d.ts',
  '@ember/utils/lib/type-of.d.ts',
  '@ember/version/index.d.ts',
  '@glimmer/tracking/index.d.ts',
  '@glimmer/tracking/primitives/cache.d.ts',
  'ember-template-compiler/index.d.ts',
  'ember-template-compiler/lib/plugins/assert-against-attrs.d.ts',
  'ember-template-compiler/lib/plugins/assert-against-named-outlets.d.ts',
  'ember-template-compiler/lib/plugins/assert-input-helper-without-block.d.ts',
  'ember-template-compiler/lib/plugins/assert-reserved-named-arguments.d.ts',
  'ember-template-compiler/lib/plugins/assert-splattribute-expression.d.ts',
  'ember-template-compiler/lib/plugins/index.d.ts',
  'ember-template-compiler/lib/plugins/transform-action-syntax.d.ts',
  'ember-template-compiler/lib/plugins/transform-each-in-into-each.d.ts',
  'ember-template-compiler/lib/plugins/transform-each-track-array.d.ts',
  'ember-template-compiler/lib/plugins/transform-in-element.d.ts',
  'ember-template-compiler/lib/plugins/transform-quoted-bindings-into-just-bindings.d.ts',
  'ember-template-compiler/lib/plugins/transform-resolutions.d.ts',
  'ember-template-compiler/lib/plugins/transform-wrap-mount-and-outlet.d.ts',
  'ember-template-compiler/lib/plugins/utils.d.ts',
  'ember-template-compiler/lib/system/bootstrap.d.ts',
  'ember-template-compiler/lib/system/calculate-location-display.d.ts',
  'ember-template-compiler/lib/system/compile-options.d.ts',
  'ember-template-compiler/lib/system/compile.d.ts',
  'ember-template-compiler/lib/system/dasherize-component-name.d.ts',
  'ember-template-compiler/lib/system/initializer.d.ts',
  'ember-template-compiler/lib/system/precompile.d.ts',
  'ember-testing/index.d.ts',
  'ember-testing/lib/adapters/adapter.d.ts',
  'ember-testing/lib/adapters/qunit.d.ts',
  'ember-testing/lib/ext/application.d.ts',
  'ember-testing/lib/ext/rsvp.d.ts',
  'ember-testing/lib/helpers.d.ts',
  'ember-testing/lib/helpers/and_then.d.ts',
  'ember-testing/lib/helpers/current_path.d.ts',
  'ember-testing/lib/helpers/current_route_name.d.ts',
  'ember-testing/lib/helpers/current_url.d.ts',
  'ember-testing/lib/helpers/pause_test.d.ts',
  'ember-testing/lib/helpers/visit.d.ts',
  'ember-testing/lib/helpers/wait.d.ts',
  'ember-testing/lib/initializers.d.ts',
  'ember-testing/lib/setup_for_testing.d.ts',
  'ember-testing/lib/test.d.ts',
  'ember-testing/lib/test/adapter.d.ts',
  'ember-testing/lib/test/helpers.d.ts',
  'ember-testing/lib/test/on_inject_helpers.d.ts',
  'ember-testing/lib/test/pending_requests.d.ts',
  'ember-testing/lib/test/promise.d.ts',
  'ember-testing/lib/test/run.d.ts',
  'ember-testing/lib/test/waiters.d.ts',
  'ember/index.d.ts',
];

const MODULES_PLACEHOLDER = '~~~MODULES GO HERE~~~';

const BASE_INDEX_D_TS = `\
/**
  *Provides **stable** type definitions for Ember.js.*

  This module is generated automatically as part of Ember's publishing process and
  should never be edited manually.

  To use these type definitions, add this import to any TypeScript file in your
  Ember app or addon:

  \`\`\`ts
  import 'ember-source/types';
  import 'ember-source/types/preview';
  \`\`\`

  @module
 */

// This works because each of these modules presents \`declare module\` definition
// of the module and *only* that, so importing this file in turn makes those
// module declarations "visible" automatically throughout a consuming project.
// Combined with use of \`typesVersions\` (or, in the future, possibly \`exports\`)
// in \`package.json\`, this allows users to import the types without knowing the
// exact layout details.
//
// Somewhat annoyingly, every single module in the graph must appear here. For
// now, while we are publishing ambient types, that means we must maintain this
// by hand. When we start emitting types from the source, we will need to do the
// same work, but automatically.

// STATUS NOTE: this does not yet include Ember's full public API, only the
// subset of it for which we have determined the types are ready to stabilize.
//
// Over time, it will come to include *all* of Ember's types, and the matching
// \`preview\` types will become empty. This is means that someone who writes the
// import we recommend--
//
// \`\`\`ts
// import 'ember-source/types';
// import 'ember-source/types/preview';
// \`\`\`
//
// --will always get the most up-to-date mix of preview and stable types, with
// no extra effort required.

${MODULES_PLACEHOLDER}
`;

const TYPES_DIR = path.join('types', 'stable');

async function main() {
  fs.rmSync(TYPES_DIR, { recursive: true, force: true });
  fs.mkdirSync(TYPES_DIR, { recursive: true });

  spawnSync('yarn', ['tsc', '--project', 'tsconfig/publish-types.json']);

  // This is rooted in the `TYPES_DIR` so that the result is just the names of
  // the modules, as generated directly from the tsconfig above.
  let moduleNames = glob.sync('**/*.d.ts', {
    ignore: 'index.d.ts', // ignore the root file itself if it somehow exists
    cwd: TYPES_DIR,
  });

  let status = 'success';
  for (let moduleName of moduleNames) {
    let result = processModule(moduleName);
    if (result !== 'success') {
      status = result;
    }
  }

  let sideEffectModules = moduleNames
    .filter((moduleName) => !PREVIEW_MODULES.includes(moduleName))
    .map((moduleName) => {
      // We need to import "package root" types as such, *not* via the actual
      // module which provides them, or TS does not see them correctly via the
      // side effect imports, so transform them accordingly:
      //
      //     `@ember/owner/index.d.ts` -> `@ember/owner`
      //
      // We also need to replace `.d.ts` entirely:
      //
      //     `@ember/utils/lib/compare.d.ts` -> `@ember/utils/lib/compare`
      //
      // Otherwise, the modules won't be resolved correctly via the side-effect
      // imports.
      let moduleOrPackagePath = moduleName.replace(/\/index.d.ts$/, '').replace('.d.ts', '');

      // Then create a relative path *to* the path on disk so that the
      // side-effect import is e.g. `import './@ember/owner';`, which makes it
      // resolve the actual local file, *not* go looking for some other package.
      return `import './${moduleOrPackagePath}';`;
    })
    .join('\n');

  let stableIndexDTsContents = BASE_INDEX_D_TS.replace(MODULES_PLACEHOLDER, sideEffectModules);
  fs.writeFileSync(path.join(TYPES_DIR, 'index.d.ts'), stableIndexDTsContents);

  // Make the generated types easier to read!
  spawnSync('prettier', ['--write', 'types/stable/**/*.ts']);

  process.exit(status === 'success' ? 0 : 1);
}

/**
  Load the module, rewrite it, and write it back to disk.

  @param {string} moduleName
  @return {'success' | 'failure'}
 */
function processModule(moduleName) {
  let modulePath = path.join(TYPES_DIR, moduleName);

  /** @type {string} */
  let contents;
  try {
    contents = fs.readFileSync(modulePath, { encoding: 'utf-8' });
  } catch (e) {
    console.error(`Error reading ${modulePath}: ${e}`);
    return 'failure';
  }

  let moduleNameForDeclaration = moduleName.replace('/index.d.ts', '');

  let rewrittenModule;
  try {
    rewrittenModule = rewriteModule(contents, moduleNameForDeclaration);
  } catch (e) {
    console.error(`Error rewriting ${moduleName}`, e);
    return 'failure';
  }

  try {
    fs.writeFileSync(modulePath, rewrittenModule);
  } catch (e) {
    console.error(`Error writing ${modulePath}: ${e}`);
    return 'failure';
  }

  return 'success';
}

/**
  Rewrite a given module declaration:

  - Tranform the main body of the module into a new top-level `declare module`
    statement.
      - Remove all `declare` modifiers from items in the module itself.
      - Update all `import` specifiers to be absolute in terms of the package
        name, which means handling both `./` and `../` correctly.
  - Preserve existing `declare module` statements, so that anything using e.g.
    declaration merging continues to work correctly.

  @param {string} code The initial code to rewrite.
  @param {string} moduleName The name of the module to use.
  @returns {string}
 */
export function rewriteModule(code, moduleName) {
  let ast = parse(code, { parser });

  /** @type {Array<import("ast-types/gen/namedTypes").namedTypes.TSModuleDeclaration>} */
  let otherModuleDeclarations = [];

  visit(ast, {
    // We need to preserve existing `declare module { ... }` blocks so that
    // things which rely on declaration merging can work, but they need to be
    // emitted *outside* the `declare module` we are introducing.
    visitTSModuleDeclaration(path) {
      otherModuleDeclarations.push(path.node);
      path.prune(path.node);
      this.traverse(path);
    },

    // Remove `declare` from `declare (let|const|var)` in the top-level module.
    visitVariableDeclaration(path) {
      if (isVariableDeclaration(path.node) && !hasParentModuleDeclarationBlock(path)) {
        path.node.declare = false;
      }
      this.traverse(path);
    },

    // Remove `declare` from `declare class` in the top-level module.
    visitClassDeclaration(path) {
      if (isClassDeclaration(path.node) && !hasParentModuleDeclarationBlock(path)) {
        path.node.declare = false;
      }
      this.traverse(path);
    },

    // Remove `declare` from `declare function` in the top-level module.
    visitTSDeclareFunction(path) {
      if (!hasParentModuleDeclarationBlock(path)) {
        path.node.declare = false;
      }
      this.traverse(path);
    },

    visitTSInterfaceDeclaration(path) {
      if (!hasParentModuleDeclarationBlock(path)) {
        path.node.declare = false;
      }
      this.traverse(path);
    },

    // Remove `declare` from `declare enum` in the top-level module.
    visitTSEnumDeclaration(path) {
      if (isTSEnumDeclaration(path.node) && !hasParentModuleDeclarationBlock(path)) {
        path.node.declare = false;
      }
      this.traverse(path);
    },

    // For any relative imports like `import { something } from './somewhere';`,
    // rewrite as `import { something } from '@ember/some-package/somewhere';`
    // since relative imports are not allowed in `declare module { }` blocks.
    visitImportDeclaration(path) {
      let source = path.node.source;
      if (isStringLiteral(source)) {
        source.value = normalizeSpecifier(moduleName, source.value);

        // This makes it so that the types we publish point to the types defined
        // by `backburner.js`, basically doing the type-time equivalent of the
        // no good, very bad runtime shenanigans Ember does... *somewhere*... in
        // the build to make `import Backburner from 'backburner'` work.
        if (source.value === 'backburner') {
          source.value = 'backburner.js';
        }
      }
      this.traverse(path);
    },

    // Do the same for `export ... from './relative-path'`.
    visitExportNamedDeclaration(path) {
      let specifier = path.node.source;
      if (isStringLiteral(specifier)) {
        specifier.value = normalizeSpecifier(moduleName, specifier.value);
      }
      this.traverse(path);
    },

    visitExportAllDeclaration(path) {
      let specifier = path.node.source;
      if (isStringLiteral(specifier)) {
        specifier.value = normalizeSpecifier(moduleName, specifier.value);
      }
      this.traverse(path);
    },

    // We need to rewrite annotations like `export const: import('./foo').foo`
    // to use relative paths, as well.
    visitTSImportType(path) {
      let specifier = path.node.argument.value;
      path.node.argument.value = normalizeSpecifier(moduleName, specifier);
      this.traverse(path);
    },
  });

  let newAST = b.file(
    b.program([
      b.declareModule(
        b.identifier(`'${moduleName.replace('.d.ts', '')}'`),
        b.blockStatement(ast.program.body)
      ),
      ...otherModuleDeclarations,
    ])
  );

  return print(newAST).code;
}

/**
  Is this declaration in a `declare module { }` block?

  @param {import('ast-types/lib/node-path').NodePath} path
  @return boolean
 */
function hasParentModuleDeclarationBlock(path) {
  /** @type {import('ast-types/lib/node-path').NodePath} */
  let parentPath = path;
  while ((parentPath = parentPath.parent)) {
    if (parentPath.node.type === 'ModuleDeclaration') {
      return true;
    }
  }

  return false;
}

const TERMINAL_MODULE_RE = /\/[\w-_]+\.d\.ts$/;
const NEIGHBOR_PATH_RE = /^(\.)\//;
const SHOULD_BE_ABSOLUTE = /(\.\.\/)+(@.*)/;

/**
  Given a relative path, `'.'`, `./`, or `(../)+`, rewrite it as an absolute path.

  @param {string} moduleName The name of the host module we are declaring.
  @param {string} specifier The name of the module it is importing.
  @return {string}
 */
function normalizeSpecifier(moduleName, specifier) {
  // One particularly degenerate case is `import()` type annotations which TS
  // generates as relative paths, e.g. `'../../@ember/object'`, since we cannot
  // yet use project references and therefore also cannot use dependencies
  // properly and therefore also cannot get TS to understand that it should be
  // writing that as an absolute specifier.
  let nonsensicalRelativePath = specifier.match(SHOULD_BE_ABSOLUTE);
  // First match is the whole string, second match is the (last) leading `../`,
  // third match is the package we care about.
  if (nonsensicalRelativePath && nonsensicalRelativePath[2]) {
    return nonsensicalRelativePath[2];
  }

  // The other cases are more normal: we replace
  if (specifier === '.') {
    return moduleName.replace(TERMINAL_MODULE_RE, '');
  } else if (specifier.startsWith('./')) {
    let parentModuleName = moduleName.replace(TERMINAL_MODULE_RE, '');
    let sansLeadingDot = specifier.replace(NEIGHBOR_PATH_RE, '');
    let newImportName = `${parentModuleName}/${sansLeadingDot}`;
    return newImportName;
  } else if (specifier.startsWith('../')) {
    // Reverse it so we can just `pop` from `parentPathChunks` as we go: walking
    // backward through the specifier means as soon as we hit the `..` we can
    // start using the chunks from the end of the hosting module.
    let reversedSpecifierChunks = specifier.split('/').reverse();
    let parentPathChunks = moduleName.split('/');

    // To make that logic work, though, we need to drop the last item from the
    // chunks comprising host module, because we need to *not* treat the current
    // module itself as a parent. If we're not in a "root" module, we need to
    // do it an extra time to get rid of the terminal `foo.d.ts` as well.
    let terminal = parentPathChunks.pop();
    if (terminal?.endsWith('.d.ts')) {
      parentPathChunks.pop();
    }

    // Walk back from the end of the specifier, replacing `..` with chunks from
    // the parent paths.
    /** @type {string[]} */
    let merged = [];
    for (let chunk of reversedSpecifierChunks) {
      if (chunk === '..') {
        let parent = parentPathChunks.pop();
        if (!parent) {
          throw new Error(
            `Could not generate a valid path for relative path specifier ${specifier} in ${moduleName}`
          );
        }
        merged.push(parent);
      } else {
        merged.push(chunk);
      }
    }

    // Reverse them again so we have the correct ordering.
    merged.reverse();
    // Then incorporate the rest of the parent path chunks.
    merged.unshift(...parentPathChunks);

    return merged.join('/');
  } else {
    return specifier;
  }
}

// Run it!
main();
