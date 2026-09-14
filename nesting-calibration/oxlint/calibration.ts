// The shared nesting calibration shapes.

// S1: no control structure.
export function flat(x: number): number {
  return x + 1;
}

// S2: one control structure.
export function oneBranch(x: number): string {
  if (x === 0) {
    return "zero";
  }
  return "other";
}

// S3: a control structure inside one.
export function branchInBranch(x: number, y: number): string {
  if (x === 0) {
    if (y === 0) {
      return "both";
    }
    return "first_only";
  }
  return "neither";
}

// S4: three control structures deep.
export function threeDeep(x: number, y: number, z: number): string {
  if (x === 0) {
    if (y === 0) {
      if (z === 0) {
        return "all";
      }
      return "two";
    }
    return "one";
  }
  return "none";
}

// S5: a closure in the function body.
export function closureInBody(xs: number[]): number[] {
  return xs.map((x) => x + 1);
}

// S6: a closure inside a branch.
export function closureInBranch(xs: number[]): number[] {
  if (xs.length > 0) {
    return xs.map((x) => x + 1);
  }
  return [];
}

// S7: a control structure inside a closure.
export function branchInClosure(xs: number[]): string[] {
  return xs.map((x) => {
    if (x === 0) {
      return "zero";
    }
    return "other";
  });
}
