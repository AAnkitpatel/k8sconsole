import type { KubeObject, ResourceRef } from '../../shared/types';

/** Picks the version a CRD stores (or the first served one). */
export function crdToRef(crd: KubeObject): ResourceRef {
  const versions: any[] = crd.spec?.versions ?? [];
  const v = versions.find((x) => x.storage) ?? versions.find((x) => x.served) ?? versions[0];
  return { apiVersion: `${crd.spec.group}/${v?.name}`, kind: crd.spec.names.kind, plural: crd.spec.names.plural, namespaced: crd.spec.scope === 'Namespaced' };
}
