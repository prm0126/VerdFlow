export const PERMISSIONS = [
  'dashboard.view',
  'studies.view',
  'phi.view',
  'hl7.raw.view',
  'errors.manage',
  'availability.manage',
  'masters.manage',
  'rules.author',
  'rules.approve',
  'users.manage',
  'audit.view',
  'vetting.perform',
  'review.perform',
  'escalations.manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLES: Record<string, { name: string; permissions: Permission[] }> = {
  admin: { name: 'Administrator', permissions: [...PERMISSIONS] },
  coordinator: {
    name: 'Reporting coordinator',
    permissions: ['dashboard.view', 'studies.view', 'phi.view', 'errors.manage', 'availability.manage', 'escalations.manage'],
  },
  radiologist: { name: 'Radiologist', permissions: ['dashboard.view', 'studies.view', 'phi.view', 'vetting.perform', 'review.perform'] },
  rule_author: { name: 'Rule author', permissions: ['dashboard.view', 'studies.view', 'rules.author'] },
  rule_approver: { name: 'Rule approver', permissions: ['dashboard.view', 'studies.view', 'rules.approve'] },
  integration: { name: 'Integration engineer', permissions: ['dashboard.view', 'studies.view', 'hl7.raw.view', 'errors.manage'] },
  viewer: { name: 'Viewer', permissions: ['dashboard.view', 'studies.view'] },
};
