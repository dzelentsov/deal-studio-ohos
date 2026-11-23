/**
 * What a person typed into a program survives a refine of it.
 *
 * A refined program is a new program with a new state class, so its state starts from its own init(). carryState takes
 * that fresh state and fills in, field by field, what the old program's state held: a field of the same name whose value
 * is of the same kind keeps the old value, every other field keeps the fresh one. A field the refine added starts at its
 * init value; one it removed is dropped; one whose kind changed (a number that became a string) starts fresh.
 *
 * An array of objects is kept only when every old element is of a class the new program still builds, with the same
 * fields (`shapes`, from VirtualMachine.classShapes): an empty fresh array says nothing about what it will hold, and an
 * entry of a reshaped class would trap the first handler that reads a field it lacks.
 *
 * The result is only a candidate: the caller runs the new program's view on it once and falls back to init() when that
 * fails (see VeraPreview.load).
 */

import { RuntimeValue, VeraNumberValue, VeraStringValue, VeraBooleanValue, VeraArrayValue, VeraObjectValue, freshObjectValue } from './VeraInterpreter'

export function carryState(fresh: RuntimeValue, old: RuntimeValue, shapes: Map<string, string[]> | null = null): RuntimeValue {
  if (fresh instanceof VeraObjectValue && old instanceof VeraObjectValue) {
    let fields: Map<string, RuntimeValue> = new Map<string, RuntimeValue>()
    fresh.fields.forEach((value: RuntimeValue, name: string) => {
      let before = old.fields.get(name)
      fields.set(name, before === undefined ? value : carryState(value, before, shapes))
    })
    return freshObjectValue(fresh.classIdentity, fields)
  }
  if (fresh instanceof VeraArrayValue && old instanceof VeraArrayValue) {
    if (old.elements.length === 0) { return fresh }
    if (!old.elements.every((e: RuntimeValue): boolean => fitsShape(e, shapes))) { return fresh }
    // With nothing fresh to compare with, the elements are kept (objects only when their class fits, above).
    if (fresh.elements.length === 0) { return old }
    return sameKind(fresh.elements[0], old.elements[0]) ? old : fresh
  }
  return sameKind(fresh, old) ? old : fresh
}

/** Whether an old object is of a class the new program builds with exactly the same fields; anything not an object fits. */
function fitsShape(value: RuntimeValue, shapes: Map<string, string[]> | null): boolean {
  if (!(value instanceof VeraObjectValue) || shapes === null) { return true }
  let fields = shapes.get(value.classIdentity)
  if (fields === undefined || fields.length !== value.fields.size) { return false }
  return fields.every((name: string): boolean => value.fields.has(name))
}

/** Whether two values are of one kind: both numbers, both strings, both booleans, both arrays, or objects of one class. */
function sameKind(a: RuntimeValue, b: RuntimeValue): boolean {
  if (a instanceof VeraNumberValue) { return b instanceof VeraNumberValue }
  if (a instanceof VeraStringValue) { return b instanceof VeraStringValue }
  if (a instanceof VeraBooleanValue) { return b instanceof VeraBooleanValue }
  if (a instanceof VeraArrayValue) { return b instanceof VeraArrayValue }
  if (a instanceof VeraObjectValue) { return b instanceof VeraObjectValue && a.classIdentity === b.classIdentity }
  return false
}
