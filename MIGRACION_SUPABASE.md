# Migración del ERP a Supabase — Instrucciones para Claude Code

## Objetivo
`erp.html` y `produccion.html` hoy guardan todo en `localStorage`. Conectarlos a
Supabase guardando **por registro** (una fila por lote / asset / cierre / etc.),
para soportar ~30 usuarios concurrentes, con **Supabase Auth + Row Level Security**.

## YA ESTÁ HECHO — NO modificar
- **`index.html`** — login con Supabase Auth (ya migrado).
- **`portal.html`** — portal del cliente leyendo de Supabase (ya migrado).
- **`supabase-data.js`** — capa de datos compartida (API abajo).
- **Esquema de Supabase** ya creado: tablas, funciones `auth_role()`,
  `auth_cliente_id()`, `next_id(prefix)`, RLS por rol y realtime.
  Falta correr el complemento de producción (`supabase_schema_produccion.sql`)
  y la función `next_num` (ver más abajo).

## TU TAREA
Reescribir **solo la capa de persistencia y autenticación** de `erp.html` y
`produccion.html`. **Conservar intacta** toda la lógica de negocio, UI y cálculos.
En ambos archivos, agregar en el `<head>` (antes de su propio `<script>`):

```html
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
<script src="supabase-data.js"></script>
```

---

## API disponible (`window.DB`)
- `await DB.login(email, password)` → `{ user, profile }`
- `await DB.logout()`
- `await DB.getSession()` → `{ user, profile } | null`
  (`profile = { user_id, role, cliente_id, nombre }`)
- `await DB.nextId(prefix)` → string id único atómico, ej. `'l8'` (ids de entidades)
- `await DB.nextNum(prefix)` → entero secuencial atómico, ej. `8`
  (para números visibles `A-0000008`, `L-…`, `SO-…`)
- `await DB.selectAll(table, filtersObj?)` → array de filas
- `await DB.upsert(table, rowObj)`
- `await DB.remove(table, col, val)`
- `DB.subscribe([tablas], callback)` → realtime

---

## Modelo de datos (memoria → tabla)
Cada fila tiene columnas relacionales + una columna `data jsonb` con el objeto completo.
- Al **leer**: reconstruir el objeto como `{ ...row.data, id: row.id, <cols> }`.
- Al **guardar**: `{ id, <cols derivadas>, data: <objeto completo> }`.

### `erp.html` — objeto `state`
| en memoria | tabla | columnas (además de `data`) |
|---|---|---|
| `state.clientes[]` | `clientes` | `id` |
| `state.lotes[]` | `lotes` | `id`, `cliente_id` (= `clienteId`), `finalizado` |
| `state.recibos{loteId}` | `recibos` | `lote_id`, `cliente_id` (del lote) |
| `state.costeos{loteId}` | `costeos` | `lote_id` |
| `state.cierres{loteId}` | `cierres` | `lote_id`, `cliente_id` (del lote) |
| catálogos* | `catalogos` | `key` (= nombre), `data` = array/objeto |

\*catálogos (una fila cada uno en `catalogos`, con `key` = el nombre):
`commodities`, `commoditiesCierre`, `hoes`, `catalogoCierre`, `categorias`,
`itemsFuncionales`, `refacciones`, `tiposServicio`, `operadoresEOL`,
`operadoresARS`, `inhabiles`, `config`, `diasEOL`, `diasARS`.
Son de baja frecuencia y escritura interna.

### `produccion.html` — objeto `pState`
| en memoria | tabla | columnas (además de `data`) |
|---|---|---|
| `pState.assets[]` | `assets` | `id`, `lote_id`, `cliente_id` (del lote del asset) |
| `pState.sortings[]` | `sortings` | `id`, `lote_id` |
| `pState.destructions[]` | `destructions` | `id`, `lote_id` |
| `pState.loads[]` | `loads` | `id` |
| `pState.lotesScraps[]` | `lotes_scraps` | `id` |
| `pState.salesOrders[]` | `sales_orders` | `id` |
| `pState.compradores[]` | `compradores` | `id` |

> **`cliente_id` es CRÍTICO** en `assets`, `recibos` y `cierres`: es lo que la RLS
> usa para que cada cliente vea solo lo suyo en el portal. Derivarlo del lote
> correspondiente (`clienteId` del lote).

---

## Estrategia de guardado (por diferencias)
Reemplazar `saveState()` / `savePState()` por un guardado **por diferencias**, para
no reescribir cada handler de mutación:
1. Mantener un *snapshot* (deep clone) del último estado guardado.
2. Al guardar, comparar el estado actual vs. el snapshot. Para cada entidad
   **nueva o cambiada**: `DB.upsert` solo esa fila. Para cada **eliminada**: `DB.remove`.
3. Actualizar el snapshot.

Así los `saveState()` que ya existen en el código siguen llamándose igual, pero por
dentro solo empujan lo que cambió. Pueden ser async fire-and-forget (con manejo de
error visible al usuario) o `await`.

## Carga inicial
Reemplazar `hydrateState()` / `loadPState()`:
1. `await DB.selectAll` de cada tabla.
2. Reconstruir `state` / `pState` con la **misma forma** de siempre (arrays de
   catálogos desde filas de `catalogos`; mapas `recibos`/`costeos`/`cierres` desde
   filas; `lotes`/`clientes`/`assets` desde filas con `{ ...data, id, <cols> }`).
3. Inicializar el snapshot con un deep clone.
4. **Conservar** el código de migración/normalización que ya existe después de reconstruir.

---

## IDs y números (IMPORTANTE)
- `uid(p)` / `puid(p)` → usar `await DB.nextId(p)`. Como es async, volver async los
  handlers de creación que lo usan y `await`. (Si en algún punto un id síncrono fuera
  realmente inevitable, usar `p + crypto.randomUUID().slice(0,8)` como último recurso,
  pero preferir `DB.nextId`.)
- **Números secuenciales visibles**: `asset.num` (`A-${num}`), `load.num` (`L-${num}`),
  `salesOrder.num` (`SO-${num}`). Usar `await DB.nextNum('asset')`, `DB.nextNum('load')`,
  `DB.nextNum('so')`. Eliminar los contadores `nextId` / `pNextId` de la persistencia.
- Las previsualizaciones del "próximo número" (mostrar el siguiente `A-…` antes de crear)
  pueden resolverse llamando `DB.nextNum` al abrir el modal, o mostrar un placeholder y
  asignar el número definitivo al guardar.

### SQL adicional a correr en Supabase (devuelve el entero, no el string)
```sql
create or replace function next_num(p text) returns bigint
language plpgsql security definer set search_path = public as $$
declare n bigint;
begin
  insert into id_counters(prefix, value) values (p, 1)
  on conflict (prefix) do update set value = id_counters.value + 1
  returning value into n;
  return n;
end $$;
```

---

## Autenticación
- `checkAuth()` →
  ```js
  const s = await DB.getSession();
  if (!s || !['admin','operador'].includes(s.profile.role)) { location.href='index.html'; return; }
  // setear state.role / state.user / badge desde s.profile
  ```
- `logout()` → `await DB.logout(); location.href='index.html';`
- **Arranque**: al final de cada archivo (`loadState();` en erp; `checkAuth();loadPState();`
  en produccion) debe volverse async: primero `await DB.getSession()` (gate de acceso),
  luego `await` la carga inicial, luego render. Envolver en un IIFE async.

## Cross-módulo (producción ↔ admin)
`produccion.html` **lee y escribe** el estado del admin:
- `getAdminState()` → reconstruir desde tablas la parte del admin que producción
  necesita (`lotes`, `clientes`, `catalogoCierre`, `commoditiesCierre`, `categorias`,
  `costeos`, `itemsFuncionales`, `config`…). Async.
- `saveAdminState(st)` → diff-upsert de las entidades admin que producción modifica.
  Identificar qué cambia (p. ej. ~línea 1954 incrementa el contador `itf` y puede crear
  `itemsFuncionales`) y persistir esas filas. Reemplazar ese contador por `DB.nextId('itf')`.

`erp.html` **lee** producción en `buildFacturaSnapshot()` (~línea 2220) → leer `sortings`
y `assets` de sus tablas filtrando por `loteId`.

## Borrado en cascada de un lote (`erp.html`, ~líneas 2050-2085)
Hoy borra los mapas del admin y reescribe `erp_prod_state`. Reemplazar por:
- `DB.remove` en `lotes` / `recibos` / `costeos` / `cierres` para ese lote.
- `DB.remove('assets'|'sortings'|'destructions', 'lote_id', id)`.
- Mantener la lógica que limpia `lotes_scraps` y `sales_orders` que referencian assets
  borrados, pero ejecutándola contra las tablas.

## Realtime
Reemplazar los `window.addEventListener('storage', …)` por:
```js
DB.subscribe(['<tablas relevantes>'], async () => {
  await hydrateState();   // o loadPState() en produccion
  renderAll(); renderActivePage();
});
```
(conviene un pequeño debounce).

## Credenciales
Poner la URL del proyecto y la *anon key* arriba de `supabase-data.js`
(`SUPABASE_URL`, `SUPABASE_ANON_KEY`). **Nunca** subir la *service_role key* al repo.

---

## Pruebas (en este orden)
1. Login como admin → entra al ERP. Recargar la página: la sesión persiste.
2. Crear un cliente, un lote, un recibo, un costeo. Recargar: los datos persisten
   (vienen de Supabase, no de localStorage).
3. En Supabase → **Table Editor**, confirmar filas en `clientes`, `lotes`, `recibos`.
4. Finalizar un lote / registrar cierre → la tabla `cierres` tiene la fila con `cliente_id`.
5. Abrir `portal.html` con un usuario cliente de ese lote → ve el lote finalizado,
   su huella y su ubicación.
6. En produccion, crear un asset de ese lote → aparece en la pestaña "Activos" del portal.
7. Números secuenciales: crear 2 assets seguidos → `A-0000001`, `A-0000002` (sin repetirse).
8. Concurrencia: abrir el ERP en dos sesiones distintas y crear lotes en cada una →
   ambos aparecen (no se pisan).
