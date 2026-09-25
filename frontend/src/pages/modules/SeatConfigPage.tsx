import {
  Armchair,
  ArrowLeft,
  Bus as BusIcon,
  CheckCircle2,
  DoorOpen,
  Footprints,
  Info,
  Layers,
  MousePointer2,
  Plus,
  Save,
  Square,
  Trash2,
  Upload,
  Users,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { LayoutCanvas, ELEMENT_LABELS, type CanvasSelection } from '@/components/common/LayoutCanvas';
import { Badge, Button, Card, Checkbox, ConfirmDialog, ErrorState, Input, LoadingState, Select, Tabs } from '@/components/ui';
import { useAuth } from '@/context/AuthContext';
import { useToast } from '@/context/ToastContext';
import { useAsync } from '@/hooks/useAsync';
import { ApiError } from '@/services/api';
import { busLayoutService, busService, seatTypeService } from '@/services';
import type { BusLayout, BusLayoutDeck, LayoutElementType, LayoutTree } from '@/types';
import { formatDate, formatNumber } from '@/utils/format';
import { cn } from '@/utils/cn';

/**
 * Editor de la distribución física de un bus (migración 010).
 *
 * EL MODELO QUE SE EDITA. Un bus no tiene asientos: tiene VERSIONES de distribución. Cada
 * versión tiene pisos, y cada piso tiene asientos y elementos —baño, escalera, conductor,
 * puerta, hueco—. Los viajes se anclan a una versión al crearse, así que una versión
 * publicada es historia y no se toca: para cambiarla se clona a un borrador, se edita el
 * borrador y se publica.
 *
 * POR QUÉ NO HAY UN BOTÓN «GUARDAR» QUE ENVÍE TODO. Cada cambio se persiste en el momento
 * contra su endpoint —crear un asiento es un POST, moverlo un PATCH—, porque el backend ya
 * valida posición, solapamientos y recuento en cada operación y dentro de su transacción.
 * Acumular el layout entero en el navegador para mandarlo de golpe significaría reimplementar
 * esas validaciones aquí y arriesgarse a que las dos versiones de la regla discreparan. El
 * botón «Guardar borrador» refresca y confirma; no reenvía nada.
 *
 * LO QUE ESTA PANTALLA NO HACE. Precios. El backend los soporta por tipo de asiento y VIAJE
 * (`trip_seat_type_prices`), no por distribución: un mismo bus cuesta distinto según la ruta.
 * Poner aquí un campo de precio mentiría sobre dónde vive ese dato.
 */
export function SeatConfigPage({ scope }: { scope: 'company' | 'admin' }) {
  const { busId: busIdParam } = useParams();
  const busId = Number(busIdParam);
  const navigate = useNavigate();
  const toast = useToast();
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('buses.update');
  const canDelete = hasPermission('buses.delete');
  const basePath = scope === 'company' ? '/company' : '/admin';

  const bus = useAsync(() => busService.get(busId), [busId]);
  const versions = useAsync(() => busLayoutService.listByBus(busId), [busId]);
  const seatTypes = useAsync(() => seatTypeService.list({ limit: 100 }), []);

  const [tab, setTab] = useState<'editor' | 'history'>('editor');
  const [tree, setTree] = useState<LayoutTree | null>(null);
  const [loadingTree, setLoadingTree] = useState(false);
  const [deckId, setDeckId] = useState<number | null>(null);
  const [tool, setTool] = useState<'select' | 'seat' | LayoutElementType>('select');
  const [selection, setSelection] = useState<CanvasSelection | null>(null);
  const [zoom, setZoom] = useState(1);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<{ kind: 'seat' | 'element' | 'deck'; id: number; label: string } | null>(null);

  const layouts = versions.data ?? [];
  const published = layouts.find((entrada) => entrada.status === 'PUBLISHED') ?? null;
  const draft = layouts.find((entrada) => entrada.status === 'DRAFT') ?? null;
  /** Se edita el borrador si lo hay; si no, se enseña la publicada en solo lectura. */
  const activeLayout: BusLayout | null = draft ?? published ?? layouts[0] ?? null;
  const editable = Boolean(canEdit && activeLayout?.status === 'DRAFT');

  /** Recarga el árbol de la versión activa. Es la única fuente de verdad de la pantalla. */
  const refreshTree = useCallback(
    async (layoutId: number) => {
      setLoadingTree(true);
      try {
        const arbol = await busLayoutService.tree(layoutId);
        setTree(arbol);
        setDeckId((actual) => {
          const sigueExistiendo = arbol.decks.some((piso) => piso.id === actual);
          return sigueExistiendo ? actual : (arbol.decks[0]?.id ?? null);
        });
      } catch (error) {
        toast.error('No se pudo cargar la distribución', error instanceof ApiError ? error.message : undefined);
      } finally {
        setLoadingTree(false);
      }
    },
    [toast],
  );

  // Solo debe dispararse al cambiar de versión: `activeLayout` es un objeto nuevo en cada recarga
  // de `versions`, y `run` ya refresca el árbol tras cada operación.
  const activeLayoutId = activeLayout?.id ?? null;
  useEffect(() => {
    if (activeLayoutId !== null) void refreshTree(activeLayoutId);
    else setTree(null);
  }, [activeLayoutId, refreshTree]);

  const deck: BusLayoutDeck | null = useMemo(
    () => tree?.decks.find((piso) => piso.id === deckId) ?? tree?.decks[0] ?? null,
    [tree, deckId],
  );
  const deckSeats = useMemo(() => (tree?.seats ?? []).filter((asiento) => asiento.deck_id === deck?.id), [tree, deck]);
  const deckElements = useMemo(() => (tree?.elements ?? []).filter((elemento) => elemento.deck_id === deck?.id), [tree, deck]);
  const selectedSeat = selection?.kind === 'seat' ? (tree?.seats ?? []).find((asiento) => asiento.id === selection.id) ?? null : null;
  const selectedElement =
    selection?.kind === 'element' ? (tree?.elements ?? []).find((elemento) => elemento.id === selection.id) ?? null : null;

  /** Envuelve cada operación: bloquea la interfaz, refresca y traduce el error del backend. */
  const run = async (accion: () => Promise<unknown>, exito?: string) => {
    if (busy) return false;
    setBusy(true);
    try {
      await accion();
      if (activeLayout) await refreshTree(activeLayout.id);
      versions.reload();
      if (exito) toast.success(exito);
      return true;
    } catch (error) {
      // El backend explica en castellano por qué no se puede: posición ocupada, versión
      // publicada, asiento con reservas. Se muestra tal cual, nunca un error de motor.
      toast.error('No se pudo completar la operación', error instanceof ApiError ? error.message : undefined);
      return false;
    } finally {
      setBusy(false);
    }
  };

  /** Número sugerido para un asiento nuevo: fila + letra de columna, como en los mockups. */
  const suggestSeatNumber = (fila: number, columna: number) => {
    const letra = String.fromCharCode(64 + Math.min(columna, 26));
    let propuesto = `${fila}${letra}`;
    const usados = new Set((tree?.seats ?? []).map((asiento) => asiento.seat_number));
    let intento = 1;
    while (usados.has(propuesto)) {
      propuesto = `${fila}${letra}${intento}`;
      intento += 1;
    }
    return propuesto;
  };

  const handlePickCell = async (fila: number, columna: number) => {
    if (!deck || !editable || tool === 'select') return;
    if (tool === 'seat') {
      await run(
        () => busLayoutService.createSeat(deck.id, { seat_number: suggestSeatNumber(fila, columna), row_number: fila, column_number: columna }),
        'Asiento añadido.',
      );
      return;
    }
    await run(
      () => busLayoutService.createElement(deck.id, { element_type: tool, row_number: fila, column_number: columna }),
      `${ELEMENT_LABELS[tool]} añadido.`,
    );
  };

  const handleDelete = async () => {
    if (!confirmDelete) return;
    const { kind, id } = confirmDelete;
    const ok = await run(
      () =>
        kind === 'seat'
          ? busLayoutService.removeSeat(id)
          : kind === 'element'
            ? busLayoutService.removeElement(id)
            : busLayoutService.removeDeck(id),
      'Eliminado correctamente.',
    );
    if (ok) {
      setConfirmDelete(null);
      setSelection(null);
    }
  };

  if (bus.loading) return <LoadingState label="Cargando bus..." />;
  if (bus.error || !bus.data) {
    return (
      <Card padded={false}>
        <ErrorState error={bus.error} onRetry={bus.reload} />
      </Card>
    );
  }

  const seatTypeOptions = (seatTypes.data?.data ?? []).map((tipo) => ({ value: tipo.id, label: tipo.name }));
  const busLabel = `${bus.data.brand ?? ''} ${bus.data.model ?? ''}`.trim();

  return (
    <>
      {/* ───────────────────────────────────────────── cabecera del bus */}
      <nav aria-label="Ruta de navegación" className="mb-3 flex flex-wrap items-center gap-1.5 text-sm">
        <button type="button" onClick={() => navigate(`${basePath}/dashboard`)} className="text-brand-600 hover:text-brand-700">
          Portal Empresa
        </button>
        <span className="text-slate-300">/</span>
        <button type="button" onClick={() => navigate(`${basePath}/buses`)} className="text-brand-600 hover:text-brand-700">
          Buses
        </button>
        <span className="text-slate-300">/</span>
        <span className="text-brand-600">{bus.data.code}</span>
        <span className="text-slate-300">/</span>
        <span className="font-medium text-slate-500">Distribución de asientos</span>
      </nav>

      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-4">
          <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-card bg-brand-50 text-brand-500 ring-1 ring-brand-100" aria-hidden>
            <BusIcon className="h-7 w-7" />
          </span>
          <div className="min-w-0">
            <h1 className="flex flex-wrap items-center gap-3 text-2xl font-bold tracking-tight text-ink sm:text-[28px]">
              {bus.data.code}
              <Badge tone={bus.data.status === 'ACTIVE' ? 'success' : 'neutral'}>
                {bus.data.status === 'ACTIVE' ? 'Activo' : bus.data.status === 'INACTIVE' ? 'Inactivo' : 'Mantenimiento'}
              </Badge>
            </h1>
            <p className="mt-0.5 text-sm text-muted">{busLabel || bus.data.plate_number}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" icon={<ArrowLeft className="h-4 w-4" />} to={`${basePath}/buses`}>
            Volver a buses
          </Button>
          <Button variant="secondary" icon={<BusIcon className="h-4 w-4" />} to={`${basePath}/buses?search=${bus.data.code}`}>
            Ver detalles del bus
          </Button>
        </div>
      </div>

      {/* ─────────────────────────────────────────── estado de la versión */}
      <VersionBanner
        published={published}
        draft={draft}
        active={activeLayout}
        decks={tree?.decks.length ?? 0}
        canEdit={canEdit}
        busy={busy}
        onCreateDraft={async () => {
          // Copy-on-write real: si hay versión publicada se clona; si el bus no tiene
          // ninguna, se crea la primera. En los dos casos decide el backend.
          const creado = await run(
            () => (published ? busLayoutService.clone(published.id) : busLayoutService.createDraft(busId)),
            published ? 'Borrador creado a partir de la versión publicada.' : 'Primera versión creada como borrador.',
          );
          if (creado) setTab('editor');
        }}
      />

      <Tabs
        tabs={[
          { id: 'editor', label: 'Editor', icon: <Layers /> },
          { id: 'history', label: 'Historial de versiones', icon: <Save /> },
        ]}
        active={tab}
        onChange={setTab}
        className="mb-5"
      />

      {tab === 'history' ? (
        <VersionHistory layouts={layouts} loading={versions.loading} />
      ) : versions.loading || loadingTree ? (
        <LoadingState label="Cargando distribución..." />
      ) : !activeLayout || !tree ? (
        <Card padded={false}>
          <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
            <span className="flex h-14 w-14 items-center justify-center rounded-full bg-brand-50 text-brand-500">
              <Armchair className="h-7 w-7" />
            </span>
            <p className="text-base font-semibold text-ink">Este bus todavía no tiene ninguna distribución</p>
            <p className="max-w-sm text-sm text-muted">
              Crea la primera versión para definir sus pisos, asientos y elementos. Hasta entonces no se le podrán programar viajes.
            </p>
          </div>
        </Card>
      ) : (
        <div className="grid gap-5 xl:grid-cols-[264px_minmax(0,1fr)_300px]">
          {/* ───────────────────────────── pisos y herramientas */}
          <div className="space-y-5">
            <Card className="p-5">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-base font-bold text-ink">Pisos</h2>
                {editable && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void run(
                        () =>
                          busLayoutService.createDeck(activeLayout.id, {
                            deck_number: Math.max(0, ...tree.decks.map((piso) => piso.deck_number)) + 1,
                            row_count: deck?.row_count ?? 0,
                            column_count: deck?.column_count ?? 0,
                          }),
                        'Piso añadido.',
                      )
                    }
                    className="flex h-8 w-8 items-center justify-center rounded-control bg-brand-500 text-white transition hover:bg-brand-600 disabled:opacity-50"
                    aria-label="Añadir piso"
                  >
                    <Plus className="h-4 w-4" />
                  </button>
                )}
              </div>

              <ul className="mt-4 space-y-2">
                {tree.decks.map((piso) => {
                  const asientos = tree.seats.filter((asiento) => asiento.deck_id === piso.id).length;
                  const activo = piso.id === deck?.id;
                  return (
                    <li key={piso.id}>
                      <div
                        className={cn(
                          'flex items-center justify-between gap-2 rounded-control border px-3 py-2.5 transition',
                          activo ? 'border-brand-300 bg-brand-50' : 'border-border hover:border-brand-200',
                        )}
                      >
                        <button
                          type="button"
                          onClick={() => {
                            setDeckId(piso.id);
                            setSelection(null);
                          }}
                          className="min-w-0 flex-1 text-left"
                        >
                          <span className={cn('block truncate text-sm font-semibold', activo ? 'text-brand-700' : 'text-ink')}>
                            {piso.name ?? `Piso ${piso.deck_number}`}
                          </span>
                          <span className="block text-xs text-muted">{formatNumber(asientos)} asientos</span>
                        </button>
                        {editable && tree.decks.length > 1 && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              setConfirmDelete({ kind: 'deck', id: piso.id, label: piso.name ?? `Piso ${piso.deck_number}` })
                            }
                            className="rounded-lg p-1.5 text-slate-400 transition hover:bg-danger-50 hover:text-danger-600"
                            aria-label={`Eliminar ${piso.name ?? `piso ${piso.deck_number}`}`}
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </Card>

            <Card className="p-5">
              <h2 className="text-base font-bold text-ink">Herramientas</h2>
              {!editable && (
                <p className="mt-2 text-xs leading-relaxed text-muted">
                  Estás viendo una versión {activeLayout.status === 'PUBLISHED' ? 'publicada' : 'archivada'}. Crea un borrador para
                  poder editarla.
                </p>
              )}
              <ul className="mt-4 space-y-1.5">
                <ToolButton
                  active={tool === 'select'}
                  disabled={!editable}
                  icon={<MousePointer2 className="h-[18px] w-[18px]" />}
                  label="Seleccionar"
                  onClick={() => setTool('select')}
                />
                <ToolButton
                  active={tool === 'seat'}
                  disabled={!editable}
                  icon={<Armchair className="h-[18px] w-[18px]" />}
                  label="Asiento"
                  onClick={() => setTool('seat')}
                />
                <ToolButton active={tool === 'BATHROOM'} disabled={!editable} icon={<Users className="h-[18px] w-[18px]" />} label="Baño" onClick={() => setTool('BATHROOM')} />
                <ToolButton active={tool === 'STAIRS'} disabled={!editable} icon={<Footprints className="h-[18px] w-[18px]" />} label="Escalera" onClick={() => setTool('STAIRS')} />
                <ToolButton active={tool === 'DRIVER'} disabled={!editable} icon={<Armchair className="h-[18px] w-[18px]" />} label="Conductor" onClick={() => setTool('DRIVER')} />
                <ToolButton active={tool === 'DOOR'} disabled={!editable} icon={<DoorOpen className="h-[18px] w-[18px]" />} label="Puerta" onClick={() => setTool('DOOR')} />
                <ToolButton active={tool === 'EMPTY'} disabled={!editable} icon={<Square className="h-[18px] w-[18px]" />} label="Espacio vacío" onClick={() => setTool('EMPTY')} />
              </ul>
              {editable && tool !== 'select' && (
                <p className="mt-4 flex items-start gap-2 rounded-control bg-brand-50 p-3 text-xs leading-relaxed text-brand-700">
                  <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  Pulsa una casilla libre del mapa para colocar {tool === 'seat' ? 'un asiento' : ELEMENT_LABELS[tool].toLowerCase()}.
                </p>
              )}
            </Card>
          </div>

          {/* ─────────────────────────────────────── mapa del piso */}
          <Card className="p-4 sm:p-5">
            {deck ? (
              <>
                <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-bold text-ink">{deck.name ?? `Piso ${deck.deck_number}`}</h2>
                    <p className="text-sm text-muted">{formatNumber(deckSeats.length)} asientos</p>
                  </div>
                  <div className="flex flex-wrap items-end gap-3">
                    <Input
                      label="Filas"
                      type="number"
                      min={1}
                      containerClassName="w-24"
                      disabled={!editable || busy}
                      defaultValue={deck.row_count || ''}
                      key={`filas-${deck.id}-${deck.row_count}`}
                      onBlur={(event) => {
                        const valor = Number(event.target.value);
                        if (!valor || valor === deck.row_count) return;
                        void run(() => busLayoutService.updateDeck(deck.id, { row_count: valor }), 'Rejilla actualizada.');
                      }}
                    />
                    <Input
                      label="Columnas"
                      type="number"
                      min={1}
                      containerClassName="w-24"
                      disabled={!editable || busy}
                      defaultValue={deck.column_count || ''}
                      key={`columnas-${deck.id}-${deck.column_count}`}
                      onBlur={(event) => {
                        const valor = Number(event.target.value);
                        if (!valor || valor === deck.column_count) return;
                        void run(() => busLayoutService.updateDeck(deck.id, { column_count: valor }), 'Rejilla actualizada.');
                      }}
                    />
                  </div>
                </div>

                <LayoutCanvas
                  deck={deck}
                  seats={deckSeats}
                  elements={deckElements}
                  selection={selection}
                  onSelect={setSelection}
                  onPickCell={editable && tool !== 'select' ? handlePickCell : undefined}
                  zoom={zoom}
                  busy={busy}
                />

                <div className="mt-4 flex items-center justify-center gap-2 border-t border-border pt-4">
                  <button
                    type="button"
                    onClick={() => setZoom((valor) => Math.max(0.6, Number((valor - 0.1).toFixed(2))))}
                    className="flex h-8 w-8 items-center justify-center rounded-control border border-border text-slate-600 transition hover:bg-slate-50"
                    aria-label="Alejar"
                  >
                    −
                  </button>
                  <span className="w-14 text-center text-sm font-medium tabular-nums text-slate-600">{Math.round(zoom * 100)}%</span>
                  <button
                    type="button"
                    onClick={() => setZoom((valor) => Math.min(1.4, Number((valor + 0.1).toFixed(2))))}
                    className="flex h-8 w-8 items-center justify-center rounded-control border border-border text-slate-600 transition hover:bg-slate-50"
                    aria-label="Acercar"
                  >
                    +
                  </button>
                  <Button variant="outline" size="sm" onClick={() => setZoom(1)}>
                    Ajustar vista
                  </Button>
                </div>
              </>
            ) : (
              <p className="py-12 text-center text-sm text-muted">Esta versión no tiene ningún piso todavía.</p>
            )}
          </Card>

          {/* ──────────────────────────────── propiedades del elemento */}
          <Card className="p-5">
            <h2 className="text-base font-bold text-ink">Propiedades del elemento</h2>

            {selectedSeat ? (
              <div className="mt-4 space-y-4">
                <div className="flex items-center justify-between gap-3">
                  <span className="flex items-center gap-2.5 text-sm font-semibold text-ink">
                    <span className="flex h-9 w-9 items-center justify-center rounded-control bg-info-50 text-info-600">
                      <Armchair className="h-[18px] w-[18px]" />
                    </span>
                    Asiento {selectedSeat.seat_number}
                  </span>
                  {editable && canDelete && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setConfirmDelete({ kind: 'seat', id: selectedSeat.id, label: `Asiento ${selectedSeat.seat_number}` })}
                      className="rounded-lg p-1.5 text-slate-400 transition hover:bg-danger-50 hover:text-danger-600"
                      aria-label="Eliminar asiento"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <Input
                    label="Número"
                    key={`num-${selectedSeat.id}-${selectedSeat.seat_number}`}
                    defaultValue={selectedSeat.seat_number}
                    disabled={!editable || busy}
                    onBlur={(event) => {
                      const valor = event.target.value.trim();
                      if (!valor || valor === selectedSeat.seat_number) return;
                      void run(() => busLayoutService.updateSeat(selectedSeat.id, { seat_number: valor }), 'Asiento actualizado.');
                    }}
                  />
                  <Select
                    label="Tipo de asiento"
                    options={seatTypeOptions}
                    placeholder="Sin tipo"
                    value={String(selectedSeat.seat_type_id ?? '')}
                    disabled={!editable || busy}
                    onChange={(event) =>
                      void run(
                        () =>
                          busLayoutService.updateSeat(selectedSeat.id, {
                            seat_type_id: event.target.value ? Number(event.target.value) : null,
                          }),
                        'Asiento actualizado.',
                      )
                    }
                  />
                  <Input
                    label="Fila"
                    type="number"
                    min={1}
                    key={`fila-${selectedSeat.id}-${selectedSeat.row_number}`}
                    defaultValue={selectedSeat.row_number ?? ''}
                    disabled={!editable || busy}
                    onBlur={(event) => {
                      const valor = Number(event.target.value);
                      if (!valor || valor === selectedSeat.row_number) return;
                      void run(() => busLayoutService.updateSeat(selectedSeat.id, { row_number: valor }), 'Asiento movido.');
                    }}
                  />
                  <Input
                    label="Columna"
                    type="number"
                    min={1}
                    key={`col-${selectedSeat.id}-${selectedSeat.column_number}`}
                    defaultValue={selectedSeat.column_number ?? ''}
                    disabled={!editable || busy}
                    onBlur={(event) => {
                      const valor = Number(event.target.value);
                      if (!valor || valor === selectedSeat.column_number) return;
                      void run(() => busLayoutService.updateSeat(selectedSeat.id, { column_number: valor }), 'Asiento movido.');
                    }}
                  />
                </div>

                {tree.decks.length > 1 && (
                  <Select
                    label="Piso"
                    options={tree.decks.map((piso) => ({ value: piso.id, label: piso.name ?? `Piso ${piso.deck_number}` }))}
                    value={String(selectedSeat.deck_id ?? '')}
                    disabled={!editable || busy}
                    onChange={(event) =>
                      void run(() => busLayoutService.updateSeat(selectedSeat.id, { deck_id: Number(event.target.value) }), 'Asiento movido de piso.')
                    }
                  />
                )}

                <Select
                  label="Estado"
                  options={[
                    { value: 'AVAILABLE', label: 'Disponible' },
                    { value: 'INACTIVE', label: 'Inactivo' },
                  ]}
                  value={selectedSeat.status}
                  disabled={!editable || busy}
                  onChange={(event) =>
                    void run(
                      () => busLayoutService.updateSeat(selectedSeat.id, { status: event.target.value as 'AVAILABLE' | 'INACTIVE' }),
                      'Asiento actualizado.',
                    )
                  }
                />

                <div className="space-y-2.5 border-t border-border pt-4">
                  <Checkbox
                    label="Junto a ventana"
                    checked={selectedSeat.is_window === 1}
                    disabled={!editable || busy}
                    onChange={(event) =>
                      void run(() => busLayoutService.updateSeat(selectedSeat.id, { is_window: event.target.checked ? 1 : 0 }), 'Asiento actualizado.')
                    }
                  />
                  <Checkbox
                    label="Junto a pasillo"
                    checked={selectedSeat.is_aisle === 1}
                    disabled={!editable || busy}
                    onChange={(event) =>
                      void run(() => busLayoutService.updateSeat(selectedSeat.id, { is_aisle: event.target.checked ? 1 : 0 }), 'Asiento actualizado.')
                    }
                  />
                </div>
              </div>
            ) : selectedElement ? (
              <div className="mt-4 space-y-4">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-semibold text-ink">{ELEMENT_LABELS[selectedElement.element_type]}</span>
                  {editable && canDelete && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        setConfirmDelete({ kind: 'element', id: selectedElement.id, label: ELEMENT_LABELS[selectedElement.element_type] })
                      }
                      className="rounded-lg p-1.5 text-slate-400 transition hover:bg-danger-50 hover:text-danger-600"
                      aria-label="Eliminar elemento"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </div>

                <Select
                  label="Tipo"
                  options={(Object.keys(ELEMENT_LABELS) as LayoutElementType[]).map((tipo) => ({ value: tipo, label: ELEMENT_LABELS[tipo] }))}
                  value={selectedElement.element_type}
                  disabled={!editable || busy}
                  onChange={(event) =>
                    void run(
                      () => busLayoutService.updateElement(selectedElement.id, { element_type: event.target.value as LayoutElementType }),
                      'Elemento actualizado.',
                    )
                  }
                />

                <div className="grid gap-3 sm:grid-cols-2">
                  <NumberField
                    label="Fila"
                    value={selectedElement.row_number}
                    disabled={!editable || busy}
                    onCommit={(valor) => run(() => busLayoutService.updateElement(selectedElement.id, { row_number: valor }), 'Elemento movido.')}
                  />
                  <NumberField
                    label="Columna"
                    value={selectedElement.column_number}
                    disabled={!editable || busy}
                    onCommit={(valor) => run(() => busLayoutService.updateElement(selectedElement.id, { column_number: valor }), 'Elemento movido.')}
                  />
                  <NumberField
                    label="Filas que ocupa"
                    value={selectedElement.row_span}
                    disabled={!editable || busy}
                    onCommit={(valor) => run(() => busLayoutService.updateElement(selectedElement.id, { row_span: valor }), 'Elemento actualizado.')}
                  />
                  <NumberField
                    label="Columnas que ocupa"
                    value={selectedElement.col_span}
                    disabled={!editable || busy}
                    onCommit={(valor) => run(() => busLayoutService.updateElement(selectedElement.id, { col_span: valor }), 'Elemento actualizado.')}
                  />
                </div>

                <Input
                  label="Etiqueta"
                  key={`label-${selectedElement.id}-${selectedElement.label ?? ''}`}
                  defaultValue={selectedElement.label ?? ''}
                  disabled={!editable || busy}
                  hint="Opcional. Se muestra al pasar el cursor."
                  onBlur={(event) => {
                    const valor = event.target.value.trim();
                    if (valor === (selectedElement.label ?? '')) return;
                    void run(() => busLayoutService.updateElement(selectedElement.id, { label: valor || null }), 'Elemento actualizado.');
                  }}
                />
              </div>
            ) : (
              <p className="mt-4 text-sm leading-relaxed text-muted">
                Selecciona un asiento o un elemento del mapa para ver y editar sus propiedades.
              </p>
            )}
          </Card>
        </div>
      )}

      {/* ──────────────────────────────────────── acciones de la versión */}
      {tab === 'editor' && activeLayout?.status === 'DRAFT' && canEdit && (
        <div className="mt-5 flex flex-wrap items-center justify-end gap-3">
          <Button
            variant="outline"
            icon={<Save className="h-4 w-4" />}
            loading={busy}
            onClick={() => {
              // Cada cambio ya quedó guardado en su momento; esto solo vuelve a leer del
              // servidor y lo confirma, sin reenviar la distribución entera.
              void refreshTree(activeLayout.id).then(() => toast.success('Borrador al día', 'Todos los cambios están guardados.'));
            }}
          >
            Guardar borrador
          </Button>
          <Button
            icon={<Upload className="h-4 w-4" />}
            loading={busy}
            onClick={() =>
              void run(() => busLayoutService.publish(activeLayout.id), 'Versión publicada. Los viajes nuevos la usarán.')
            }
          >
            Publicar versión
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={confirmDelete !== null}
        onClose={() => setConfirmDelete(null)}
        onConfirm={handleDelete}
        loading={busy}
        title="Eliminar"
        confirmLabel="Sí, eliminar"
        message={
          <>
            ¿Seguro que deseas eliminar <strong>{confirmDelete?.label}</strong>? Si tiene reservas asociadas o el piso no está vacío, el
            servidor rechazará la operación y te lo explicará.
          </>
        }
      />
    </>
  );
}

/** Botón de herramienta del panel izquierdo. */
function ToolButton({
  active,
  disabled,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  disabled: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        disabled={disabled}
        onClick={onClick}
        aria-pressed={active}
        className={cn(
          'flex w-full items-center gap-3 rounded-control px-3 py-2.5 text-sm font-medium transition',
          active ? 'bg-brand-50 text-brand-700 ring-1 ring-brand-200' : 'text-slate-600 hover:bg-slate-50',
          disabled && 'cursor-not-allowed opacity-40',
        )}
      >
        <span className={active ? 'text-brand-500' : 'text-slate-400'}>{icon}</span>
        {label}
      </button>
    </li>
  );
}

/** Campo numérico que solo envía al salir del foco y cuando el valor cambió de verdad. */
function NumberField({
  label,
  value,
  disabled,
  onCommit,
}: {
  label: string;
  value: number;
  disabled: boolean;
  onCommit: (valor: number) => Promise<unknown>;
}) {
  return (
    <Input
      label={label}
      type="number"
      min={1}
      key={`${label}-${value}`}
      defaultValue={value}
      disabled={disabled}
      onBlur={(event) => {
        const siguiente = Number(event.target.value);
        if (!siguiente || siguiente === value) return;
        void onCommit(siguiente);
      }}
    />
  );
}

/** Estado de la versión y el paso a borrador. */
function VersionBanner({
  published,
  draft,
  active,
  decks,
  canEdit,
  busy,
  onCreateDraft,
}: {
  published: BusLayout | null;
  draft: BusLayout | null;
  active: BusLayout | null;
  decks: number;
  canEdit: boolean;
  busy: boolean;
  onCreateDraft: () => void;
}) {
  if (!active) return null;
  const enBorrador = active.status === 'DRAFT';

  return (
    <Card className={cn('mb-5 p-5', enBorrador && 'border-warning-500/40 bg-warning-50/60')}>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
        <div className="flex flex-wrap items-start gap-x-8 gap-y-3">
          <div>
            <p className="flex items-center gap-2.5 text-sm font-semibold text-ink">
              {enBorrador ? 'Editando borrador' : 'Versión actual'}
              <Badge tone={enBorrador ? 'warning' : active.status === 'PUBLISHED' ? 'success' : 'neutral'}>
                {enBorrador ? 'BORRADOR' : active.status === 'PUBLISHED' ? 'PUBLICADA' : 'ARCHIVADA'}
              </Badge>
            </p>
            <p className="mt-1 text-sm text-muted">
              v{active.version} · {formatNumber(active.seat_count)} asientos · {formatNumber(decks)} {decks === 1 ? 'piso' : 'pisos'}
            </p>
            {active.published_at && <p className="mt-0.5 text-xs text-muted">Publicado el {formatDate(active.published_at)}</p>}
          </div>

          {enBorrador && published && (
            <p className="flex items-start gap-2 text-xs leading-relaxed text-slate-600">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success-600" />
              La v{published.version} sigue publicada y atendiendo a los viajes ya creados hasta que publiques esta.
            </p>
          )}
        </div>

        {!enBorrador && canEdit && !draft && (
          <div className="flex flex-wrap items-center gap-3 lg:justify-end">
            <p className="flex items-start gap-2 text-xs leading-relaxed text-muted lg:max-w-xs">
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-brand-500" />
              Para realizar cambios debes crear un borrador. Se copiará esta versión y podrás editarla sin afectar a los viajes
              existentes.
            </p>
            <Button icon={<Plus className="h-4 w-4" />} loading={busy} onClick={onCreateDraft}>
              Crear borrador
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}

/** Historial real de versiones del bus. */
function VersionHistory({ layouts, loading }: { layouts: BusLayout[]; loading: boolean }) {
  if (loading) return <LoadingState label="Cargando versiones..." />;
  if (layouts.length === 0) {
    return (
      <Card padded={false}>
        <p className="px-6 py-12 text-center text-sm text-muted">Este bus todavía no tiene ninguna versión de distribución.</p>
      </Card>
    );
  }

  return (
    <Card padded={false}>
      <ul className="divide-y divide-border">
        {layouts.map((layout) => (
          <li key={layout.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
            <div className="min-w-0">
              <p className="flex flex-wrap items-center gap-2.5 text-sm font-semibold text-ink">
                {layout.name ?? `Versión ${layout.version}`}
                <Badge tone={layout.status === 'PUBLISHED' ? 'success' : layout.status === 'DRAFT' ? 'warning' : 'neutral'}>
                  {layout.status === 'PUBLISHED' ? 'PUBLICADA' : layout.status === 'DRAFT' ? 'BORRADOR' : 'ARCHIVADA'}
                </Badge>
              </p>
              <p className="mt-0.5 text-xs text-muted">
                v{layout.version} · {formatNumber(layout.seat_count)} asientos
                {layout.published_at ? ` · Publicada el ${formatDate(layout.published_at)}` : ''}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
