/** The role model (AccessService): levels for the existing checks, and who may give or take which role. */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { ASSIGNABLE_ROLES, canAssign, isScoped, LEVEL, MemberRole } from '../src/common/access.service';

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
  it('teachers and trainers bring in students only; nobody else below admin, and no individual, assigns anything', () => {
    for (const caller of ['teacher', 'trainer'] as MemberRole[]) {
      for (const r of ALL) expect(canAssign(caller, r)).toBe(r === 'student');
    }
    for (const caller of ['individual', 'engineer', 'viewer', 'student', 'employee'] as MemberRole[]) {
      for (const r of ALL) expect(canAssign(caller, r)).toBe(false);
    }
    expect(canAssign(null, 'viewer')).toBe(false);
  });
  it('the scoped roles are exactly teacher, trainer, student, employee', () => {
    expect(ALL.filter((r) => isScoped(r))).toEqual(['teacher', 'trainer', 'student', 'employee']);
    expect(ASSIGNABLE_ROLES).toEqual(['admin', 'teacher', 'trainer', 'engineer', 'student', 'employee', 'viewer']);
  });
});
