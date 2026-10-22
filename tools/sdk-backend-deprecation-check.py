#!/usr/bin/env python3
import contextlib
import copy
import io
import json
import runpy
import unittest
from pathlib import Path
from unittest.mock import patch

TOOLS = Path(__file__).resolve().parent
ROOT = TOOLS.parent
GENERATOR = runpy.run_path(str(TOOLS / 'generate-sdk-backend.py'))
CAPABILITY = 'SystemCapability.HiviewDFX.HiProfiler.HiDebug'
OTHER_CAPABILITY = 'SystemCapability.Test.Other'
OLD_TARGET = 'PerformanceAnalysisKit.hidebug.dumpJsHeapData'
RAW_TARGET = 'PerformanceAnalysisKit.hidebug.dumpJsRawHeapData'


def candidate(name='dumpJsHeapData', params=None, return_type='void', promise=False):
    return {
        'target': 'PerformanceAnalysisKit.hidebug.' + name,
        'module': 'hidebug',
        'name': name,
        'file': '@ohos.hidebug.d.ts',
        'params': [['filename', 'string', False]] if params is None else params,
        'returnType': return_type,
        'isPromise': promise,
        'deprecated': False,
    }


def declaration(name='dumpJsHeapData', params='filename: string', return_type='void',
                deprecated=False, capability=CAPABILITY):
    tags = ('@deprecated since 26\n' if deprecated else '')
    if capability:
        tags += '@syscap ' + capability + '\n'
    return f'/**\n{tags}*/\nfunction {name}({params}): {return_type};\n'


class DeprecationCheck(unittest.TestCase):
    def attach(self, selected, *declarations, namespace_capability=''):
        prefix = f'/** @syscap {namespace_capability} */\n' if namespace_capability else ''
        source = prefix + 'declare namespace hidebug {\n' + ''.join(declarations) + '}\n'
        stderr = io.StringIO()
        with patch.object(Path, 'is_file', return_value=True), \
                patch.object(Path, 'read_text', return_value=source), \
                contextlib.redirect_stderr(stderr):
            GENERATOR['attach_syscaps'](selected, Path('/sdk'))
        return stderr.getvalue()

    def test_stale_selected_deprecated_signature_is_removed(self):
        selected = [candidate()]
        diagnostic = self.attach(selected, declaration(deprecated=True))
        self.assertEqual(selected, [])
        self.assertIn(OLD_TARGET + ': skipped deprecated SDK signature; no adapter generated', diagnostic)
        self.assertEqual(GENERATOR['build_import_table'](selected), {})

    def test_live_overload_survives_without_deprecated_syscap_ambiguity(self):
        for deprecated_first in (True, False):
            with self.subTest(deprecated_first=deprecated_first):
                selected = [candidate()]
                overloads = [declaration(deprecated=True, capability=OTHER_CAPABILITY), declaration()]
                if not deprecated_first:
                    overloads.reverse()
                self.assertEqual(self.attach(selected, *overloads), '')
                self.assertEqual(selected[0]['syscaps'], [CAPABILITY])
                entry = GENERATOR['gen_entry'](selected[0], GENERATOR['build_import_table'](selected))
                self.assertIn('hidebug.dumpJsHeapData(filename)', entry)
                self.assertNotIn(OTHER_CAPABILITY, entry)

    def test_unrelated_live_overload_does_not_rescue_deprecated_signature(self):
        selected = [candidate()]
        self.attach(selected, declaration(deprecated=True), declaration(params='filename: number'))
        self.assertEqual(selected, [])

    def test_optional_live_overload_can_match(self):
        selected = [candidate()]
        self.attach(selected, declaration(deprecated=True),
                    declaration(params='filename: string, needClean?: boolean'))
        self.assertEqual(len(selected), 1)
        self.assertEqual(selected[0]['syscaps'], [CAPABILITY])

    def test_required_live_argument_does_not_rescue_deprecated_signature(self):
        selected = [candidate()]
        self.attach(selected, declaration(deprecated=True),
                    declaration(params='filename: string, needClean: boolean'))
        self.assertEqual(selected, [])

    def test_missing_or_ambiguous_live_syscap_still_fails(self):
        for overloads in ((declaration(capability=''),),
                          (declaration(), declaration(capability=OTHER_CAPABILITY)),
                          (declaration(params='filename: number'),)):
            with self.subTest(overloads=overloads), self.assertRaisesRegex(
                    SystemExit, 'missing or ambiguous @syscap'):
                self.attach([candidate()], *overloads)

    def test_deprecated_signature_needs_no_syscap(self):
        selected = [candidate()]
        self.attach(selected, declaration(deprecated=True, capability=''))
        self.assertEqual(selected, [])

    def test_namespace_syscap_and_numeric_normalization_preserved(self):
        selected = [candidate(params=[['filename', 'int', False]])]
        self.attach(selected, declaration(params='filename: number', capability=''),
                    namespace_capability=CAPABILITY)
        self.assertEqual(selected[0]['syscaps'], [CAPABILITY])

    def test_raw_heap_adapter_semantics_unchanged(self):
        selected = [candidate(), candidate('dumpJsRawHeapData',
                    [['needGC', 'boolean', True]], 'string', True)]
        self.attach(selected, declaration(deprecated=True),
                    declaration('dumpJsRawHeapData', 'needGC?: boolean', 'Promise<string>'),
                    declaration('dumpJsRawHeapData', 'needGC: boolean, needClean: boolean', 'Promise<string>'))
        self.assertEqual([entry['target'] for entry in selected], [RAW_TARGET])
        entry = GENERATOR['gen_entry'](selected[0], GENERATOR['build_import_table'](selected))
        self.assertIn("paramBoolean(params, 'needGC', false)", entry)
        self.assertIn('let result = await hidebug.dumpJsRawHeapData(needGC)', entry)
        self.assertIn('return result.toString()', entry)
        self.assertNotIn(OLD_TARGET + "'", entry)

    def test_targeted_metadata(self):
        index = json.loads((ROOT / 'entry/src/main/resources/rawfile/sdk-index.json').read_text())
        old = [entry for entry in index if entry['module'] == 'hidebug' and entry['name'] == 'dumpJsHeapData']
        self.assertTrue(old)
        self.assertTrue(all(entry['deprecated'] for entry in old))
        selected = json.loads((TOOLS / 'sdk-backend-selected.json').read_text())
        self.assertNotIn(OLD_TARGET, [entry['target'] for entry in selected])
        raw = next(entry for entry in selected if entry['target'] == RAW_TARGET)
        self.assertEqual(raw['params'], [['needGC', 'boolean', True]])
        self.assertEqual((raw['returnType'], raw['isPromise']), ('string', True))
        original = copy.deepcopy(raw)
        self.attach([raw], declaration('dumpJsRawHeapData', 'needGC?: boolean', 'Promise<string>'))
        raw.pop('syscaps')
        self.assertEqual(raw, original)


if __name__ == '__main__':
    unittest.main()
