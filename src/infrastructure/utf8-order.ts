/** UTF-8 byte ordering, including replacement of unpaired UTF-16 surrogates. */
export function compareUtf8(left: string, right: string): number {
  if (left === right) return 0;
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    const leftCode = left.codePointAt(leftIndex)!;
    const rightCode = right.codePointAt(rightIndex)!;
    if (leftCode !== rightCode) {
      const leftScalar =
        leftCode >= 0xd800 && leftCode <= 0xdfff ? 0xfffd : leftCode;
      const rightScalar =
        rightCode >= 0xd800 && rightCode <= 0xdfff ? 0xfffd : rightCode;
      if (leftScalar !== rightScalar) return leftScalar - rightScalar;
    }
    leftIndex += leftCode > 0xffff ? 2 : 1;
    rightIndex += rightCode > 0xffff ? 2 : 1;
  }
  return Number(leftIndex < left.length) - Number(rightIndex < right.length);
}
