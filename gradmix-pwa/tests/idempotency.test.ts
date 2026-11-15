import assert from 'node:assert/strict';
import test from 'node:test';
import { IdempotentController, createRequestId } from '../src/lib/utils/idempotency.ts';

test('IdempotentController ejecuta 1 sola petición ante clics rápidos simultáneos y desbloquea al terminar', async () => {
  const events: string[][] = [];
  const ctrl = new IdempotentController((keys) => events.push([...keys]));

  let calls = 0;
  const runOnce = () =>
    ctrl.run(
      'room:create',
      async () => {
        calls += 1;
        await new Promise((r) => setTimeout(r, 40));
        return 'ok';
      },
      { minLockMs: 50 }
    );

  const [a, b, c] = await Promise.all([runOnce(), runOnce(), runOnce()]);
  assert.equal(calls, 1);
  assert.equal(a.executed, true);
  assert.equal(a.value, 'ok');
  assert.equal(b.executed, false);
  assert.equal(c.executed, false);
  assert.equal(ctrl.isLocked('room:create'), false);

  // Tras finalizar el bloqueo, una nueva acción sí se ejecuta
  const d = await runOnce();
  assert.equal(calls, 2);
  assert.equal(d.executed, true);
});

test('IdempotentController libera el bloqueo incluso si la operación falla', async () => {
  const ctrl = new IdempotentController();
  await assert.rejects(
    ctrl.run(
      'search:dl',
      async () => {
        throw new Error('fallo de red');
      },
      { minLockMs: 20 }
    ),
    /fallo de red/
  );
  assert.equal(ctrl.isLocked('search:dl'), false);
  assert.ok(createRequestId().length >= 8);
});
