/** The role model (AccessService): levels for the existing checks, and who may give or take which role. */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { ASSIGNABLE_ROLES, canAssign, LEVEL, MemberRole } from '../src/common/access.service';

const ALL: MemberRole[] = ['owner', 'admin', 'teacher', 'trainer', 'engineer', 'student', 'employee', 'viewer', 'individual'];

describe('roles', () => {
  it('every role has a level; scoped roles never exceed engineer', () => {
    for (const r of ALL) expect(LEVEL[r]).toBeDefined();
    expect(['teacher', 'trainer', 'student', 'employee'].map((r) => LEVEL[r as MemberRole])).toEqual(['engineer', 'engineer', 'viewer', 'viewer']);
  });
  it('owner and individual are never assigned, by anyone', () => {
    for (const caller of ALL) {
      expect(canAssign(caller, 'owner')).toBe(false);
      expect(canAssign(caller, 'individual')).toBe(false);
    }
    expect(ASSIGNABLE_ROLES).not.toContain('owner');
  });
  it('only the owner deals with admins; admins manage the roles below', () => {
    expect(canAssign('owner', 'admin')).toBe(true);
    expect(canAssign('admin', 'admin')).toBe(false);
    expect(canAssign('admin', 'engineer')).toBe(true);
    expect(canAssign('admin', 'viewer')).toBe(true);
  });
  it('nobody below admin, and no individual, assigns anything', () => {
    for (const caller of ['individual', 'engineer', 'teacher', 'trainer', 'viewer', 'student', 'employee'] as MemberRole[]) {
      for (const r of ALL) expect(canAssign(caller, r)).toBe(false);
    }
    expect(canAssign(null, 'viewer')).toBe(false);
  });
});
