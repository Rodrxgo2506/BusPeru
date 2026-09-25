import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import {
  __resetRefreshStatusForTests,
  beginRefresh,
  FAILURE_NOTICE_MS,
  getRefreshSnapshot,
  reportRefreshFailure,
  reportRefreshSuccess,
  subscribeRefresh,
} from './refresh-status.ts';

describe('Estado de actualización en segundo plano (F18-16)', () => {
  let t = 0;
  beforeEach(() => {
    t = 0;
    __resetRefreshStatusForTests(() => t);
  });

  it('refleja las actualizaciones en curso y termina cuando acaba la última', () => {
    const fin1 = beginRefresh();
    const fin2 = beginRefresh();
    assert.equal(getRefreshSnapshot().refreshing, true);
    fin1();
    assert.equal(getRefreshSnapshot().refreshing, true, 'aún queda una');
    fin2();
    assert.equal(getRefreshSnapshot().refreshing, false);
  });

  it('terminar dos veces la misma actualización no descuadra el contador', () => {
    const fin = beginRefresh();
    fin();
    fin();
    const otra = beginRefresh();
    assert.equal(getRefreshSnapshot().refreshing, true);
    otra();
    assert.equal(getRefreshSnapshot().refreshing, false);
  });

  it('un fallo se avisa un tiempo y una actualización correcta lo retira', () => {
    reportRefreshFailure();
    assert.equal(getRefreshSnapshot().failed, true);
    reportRefreshSuccess();
    assert.equal(getRefreshSnapshot().failed, false);
    reportRefreshFailure();
    t += FAILURE_NOTICE_MS + 1;
    beginRefresh()(); // cualquier cambio recalcula el estado
    assert.equal(getRefreshSnapshot().failed, false, 'el aviso caduca solo');
  });

  it('avisa a los suscriptores solo cuando cambia el estado y devuelve el mismo objeto si no cambia', () => {
    let avisos = 0;
    const baja = subscribeRefresh(() => { avisos += 1; });
    const antes = getRefreshSnapshot();
    const fin = beginRefresh();
    const durante = getRefreshSnapshot();
    const fin2 = beginRefresh();
    assert.equal(getRefreshSnapshot(), durante, 'sin cambio visible, mismo objeto');
    fin2();
    fin();
    baja();
    assert.notEqual(antes, durante);
    assert.equal(avisos, 2);
  });
});
