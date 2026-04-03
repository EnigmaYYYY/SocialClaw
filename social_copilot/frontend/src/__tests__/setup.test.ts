import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import { z } from 'zod'

describe('Project Setup Verification', () => {
  it('should have vitest working', () => {
    expect(1 + 1).toBe(2)
  })

  it('should have fast-check working', () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer(), (a, b) => {
        return a + b === b + a
      }),
      { numRuns: 100 }
    )
  })

  it('should have zod working', () => {
    const schema = z.object({
      name: z.string(),
      age: z.number()
    })

    const result = schema.safeParse({ name: 'test', age: 25 })
    expect(result.success).toBe(true)
  })
})
