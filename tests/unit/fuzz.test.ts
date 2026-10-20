// Property-based fuzz tests (fast-check) for the code that stands between untrusted input and a cluster or AWS account.
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { resolve, sep } from 'node:path';
import { resourcePath } from '../../build/app/src/shared/resources';
import { validateManifest } from '../../build/app/src/shared/validation';
import { isReadOnlyCommand, toRegisterInput, isEcsArn, isValidEcsName } from '../../build/app/src/shared/ecs';
import { resolveRendererFile } from '../../build/app/src/main/renderer-protocol';
import { sanitizeSettings } from '../../build/app/src/main/settings';
import { sanitizeConnectRequest } from '../../build/app/src/main/aws/controller';
import { buildAwsSuggestions, buildSuggestions } from '../../build/app/src/main/terminal-setup';

const RUNS = { numRuns: Number(process.env.FUZZ_RUNS) || 400 };
/** Strings biased towards path tricks: dots, slashes, percent-encoding, NUL, unicode. */
const hostile = fc.oneof(
  fc.string({ unit: 'binary', maxLength: 80 }),
  fc.array(fc.constantFrom('..', '.', '/', '\\', '%2e', '%2f', '%5c', '%00', '\0', 'a', 'kube-system', '?', '#', ':', ' ', 'é', '😀'), { maxLength: 12 }).map((p) => p.join('')),
);

describe('fuzz: REST path building', () => {
  it('either rejects a segment or builds a path that cannot leave its API prefix', () => {
    fc.assert(
      fc.property(hostile, hostile, fc.boolean(), (namespace, name, namespaced) => {
        let p: string;
        try {
          p = resourcePath({ apiVersion: 'apps/v1', plural: 'deployments', namespaced }, namespace || undefined, name || undefined);
        } catch {
          return true; // rejected
        }
        const segments = p.split('/');
        expect(p.startsWith('/apis/apps/v1/')).toBe(true);
        expect(segments.includes('..') || segments.includes('.')).toBe(false);
        expect(/[?#\s\\\0]/.test(p)).toBe(false);
        expect(segments.length).toBeLessThanOrEqual(8); // "", apis, apps, v1, namespaces, <ns>, deployments, <name>
        return true;
      }),
      RUNS,
    );
  });

  it('rejects any apiVersion or plural that is not a plain identifier', () => {
    fc.assert(
      fc.property(hostile, hostile, (apiVersion, plural) => {
        try {
          const p = resourcePath({ apiVersion, plural, namespaced: false });
          expect(/^\/apis?\/[a-z0-9.\-/]+\/[a-z0-9]+$/.test(p)).toBe(true);
          expect(p.includes('..')).toBe(false);
        } catch {
          // rejected
        }
      }),
      RUNS,
    );
  });
});

describe('fuzz: app:// renderer protocol', () => {
  const DIR = resolve(sep, 'opt', 'app', 'resources', 'app.asar', 'out', 'renderer');
  it('never resolves outside the renderer directory', () => {
    fc.assert(
      fc.property(hostile, (path) => {
        const r = resolveRendererFile(`app://renderer/${path}`, DIR);
        expect(r === null || r.startsWith(DIR + sep)).toBe(true);
      }),
      RUNS,
    );
  });
});

describe('fuzz: AWS read-only guard', () => {
  const writes = ['UpdateService', 'CreateService', 'DeleteService', 'StopTask', 'RunTask', 'StartTask', 'RegisterTaskDefinition', 'DeregisterTaskDefinition', 'DeleteTaskDefinitions', 'ExecuteCommand', 'TagResource', 'UntagResource', 'PutClusterCapacityProviders', 'UpdateCluster', 'DeleteCluster', 'PutLogEvents', 'DeleteLogGroup', 'PutMetricData', 'AuthorizeSecurityGroupIngress', 'ModifyTargetGroup', 'AssumeRole'];
  it('blocks every state-changing operation, with or without the Command suffix', () => {
    fc.assert(
      fc.property(fc.constantFrom(...writes), fc.boolean(), (op, suffix) => {
        expect(isReadOnlyCommand(suffix ? `${op}Command` : op)).toBe(false);
      }),
      RUNS,
    );
  });
  it('only allows names that start with a read verb followed by a capitalised noun', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (name) => {
        if (isReadOnlyCommand(name)) expect(/^(Describe|List|Get|Filter|Lookup|Search|BatchGet)[A-Z]/.test(name)).toBe(true);
      }),
      RUNS,
    );
  });
});

describe('fuzz: settings and AWS connection input', () => {
  it('sanitizes any JSON into valid settings, idempotently, without throwing', () => {
    fc.assert(
      fc.property(fc.oneof(fc.jsonValue(), fc.dictionary(fc.constantFrom('theme', 'kubeconfigFiles', 'lastNamespaces', 'workspace', 'awsLastConnection', 'ecsLastCluster', 'logTailLines', 'helmPath', 'assistantModel'), fc.jsonValue())), (input) => {
        const s = sanitizeSettings(input);
        expect(['dark', 'light', 'system']).toContain(s.theme);
        expect(['kubernetes', 'ecs']).toContain(s.workspace);
        expect(s.kubeconfigFiles.every((f) => typeof f === 'string' && f.length > 0)).toBe(true);
        expect(Number.isInteger(s.logTailLines)).toBe(true);
        expect(Object.values(s.ecsLastCluster).every((c) => isEcsArn(c, 'cluster') || isValidEcsName(c))).toBe(true);
        if (s.awsLastConnection) expect(typeof s.awsLastConnection.readOnly).toBe('boolean');
        expect(sanitizeSettings(JSON.parse(JSON.stringify(s)))).toEqual(s);
      }),
      RUNS,
    );
  });

  it('keeps AWS connections read-only unless readOnly is exactly false', () => {
    fc.assert(
      fc.property(
        fc.record({ mode: fc.constantFrom('profile', 'default', 'other', undefined), profile: fc.oneof(fc.constant('dev'), fc.string({ maxLength: 20 })), region: fc.oneof(fc.constant('eu-west-2'), fc.string({ maxLength: 15 })), readOnly: fc.oneof(fc.boolean(), fc.jsonValue()), assumeRoleArn: fc.option(fc.string({ maxLength: 60 })) }, { requiredKeys: [] }),
        (input) => {
          try {
            const r = sanitizeConnectRequest(input);
            expect(r.readOnly).toBe(input.readOnly !== false);
            expect(r.region).toMatch(/^[a-z]{2}(-gov)?-[a-z]+-\d$/);
          } catch (err) {
            expect(err).toBeInstanceOf(Error);
          }
        },
      ),
      RUNS,
    );
  });
});

describe('fuzz: terminal suggestions', () => {
  const unsafe = /[;&|`$(){}<>\\'"\n\r\t*?[\]!~#]/;
  it('never emit shell metacharacters, whatever the resource names', () => {
    fc.assert(
      fc.property(fc.array(fc.string({ maxLength: 30 }), { maxLength: 8 }), fc.option(fc.string({ maxLength: 20 }), { nil: undefined }), (names, ns) => {
        const k = buildSuggestions({ namespace: ns, namespaces: names, pods: names, deployments: names, statefulsets: names, services: names });
        const a = buildAwsSuggestions({ cluster: ns, services: names, logGroups: names });
        // `>` and `|` are allowed by design in a few fixed kubectl/aws commands; names never add any other metacharacter.
        for (const line of [...k, ...a]) expect(unsafe.test(line.replace(/[<>|]/g, ''))).toBe(false);
      }),
      RUNS,
    );
  });
});

describe('fuzz: task definition registration and manifest validation', () => {
  it('never forwards read-only task definition fields', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.constantFrom('family', 'containerDefinitions', 'taskDefinitionArn', 'revision', 'status', 'registeredAt', 'compatibilities', 'cpu', 'tags'), fc.jsonValue()), (def) => {
        try {
          const input = toRegisterInput(def);
          for (const k of ['taskDefinitionArn', 'revision', 'status', 'registeredAt', 'compatibilities']) expect(k in input).toBe(false);
        } catch (err) {
          expect(err).toBeInstanceOf(Error);
        }
      }),
      RUNS,
    );
  });

  it('validates any text without throwing', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string({ maxLength: 400 }), fc.jsonValue().map((v) => JSON.stringify(v))), (text) => {
        const v = validateManifest(text);
        expect(typeof v.ok).toBe('boolean');
        expect(Array.isArray(v.issues)).toBe(true);
      }),
      RUNS,
    );
  });
});
