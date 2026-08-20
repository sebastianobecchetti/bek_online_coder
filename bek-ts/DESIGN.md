# DESIGN — Port TypeScript/Node del codec BEK

> Target: `bek-ts`, ESM + TypeScript, stesso stack di `@playcanvas/splat-transform`.
> Sorgenti C++ di riferimento: https://github.com/sebastianobecchetti/bek
> Scope: **solo il punto operativo di default**. Nessun flag CLI, nessun braccio alternativo.

---

## 0. Punto operativo di default (congelato)

Da `ply_to_bek.cpp:80-144`:

| parametro | default |
|---|---|
| `dc_stages` | 2 |
| `sh_stages` (joint, 45 dim) | 3 |
| `scale_stages` | 0 → scales in `u8_levels` |
| `pos_fractional_bits` | 9 |
| `rot_mag_bits` | 6, `rot_split` false → `smallest3_24` |
| `vq_iters` | 30, cluster/stage 256 |
| `sort_mode` 0 (Morton), `sort_refine` 128, `sort_metric` 0 (L1) |
| `sh_whiten` 0 → pesi vuoti, L2 puro |
| `cb_chain_order` | **true** |
| `cb_float`, `pos_joint`, `legacy_tail`, `dc_kmeans`, `sh_kmeans`, `no_*` | off |

**Canali prodotti (dopo `std::sort` per nome):**
`opacity`, `pos_x`, `pos_y`, `pos_z`, `rotation`, `scales`, `vq_dc_s0`, `vq_dc_s1`, `vq_sh_ac_s0`, `vq_sh_ac_s1`, `vq_sh_ac_s2` — 11 canali.

---

## 1. Inventario moduli → file TS

### 1.1 Da portare

| C++ | funzioni sul percorso di default | → TS |
|---|---|---|
| `ply_reader.cpp` | `read_ply`, `part1by2`/`encode_morton`, `refine_2opt` + `cost_l1`, `sort_morton`, `reorder` | `src/ply.ts` + `src/order.ts` |
| `quantization.cpp` | `quantize_position_spz_zz` / `dequantize_position_spz_zz`, `quantize_opacity_sigmoid` / `dequantize_opacity_sigmoid`, `pack_quaternion_smallest_three_var` / `unpack_..._var`, `quantize_to_u8_levels` / `dequantize_from_u8_levels` | `src/quantize.ts` |
| `sh_vq.cpp` | `compute_dist_sq`, `train_vq_optimized`, `assign_vq_optimized`, `reorder_codebook_chain`, `compute_rvq`, `quantize_scalar_lloyd`, `pack_rvq_pooled` | `src/rvq.ts` |
| `range_coder.cpp` | `RangeEncoder`/`RangeDecoder`, `rc1_*`, `rc2_*`, `rcx_*`, `posmag_*`, `rotpack_*` | `src/rangecoder.ts` |
| `ply_writer.cpp` | `write_ply_file` (layout tinyply) | `src/ply.ts` |
| `ply_to_bek.cpp` | assemblaggio canali, best-of codec, header CBOR, container BEK3 + zstd | `src/encode.ts` + `src/container.ts` |
| `bek_to_ply.cpp` | parsing container, dispatch codec, ricostruzione attributi | `src/decode.ts` |
| `nlohmann::json::to_cbor/from_cbor` | CBOR canonico nlohmann | `src/cbor.ts` |

### 1.2 Da NON portare (servono solo varianti non-default) — omettere in fase 1

> **Aggiornamento (parità di flag, ondata 1+2 parziale):** questa sezione
> descriveva lo scope della fase 1 (solo punto operativo di default). Da
> allora sono stati portati: tutti i flag dell'ondata 1
> (`--dc-stages`/`--sh-stages`/`--sh1-stages`/`--vq-iters`/`--pos-bits`/
> `--sort-refine`/`--rot-mag-bits`/`--rvq-cb-order`/`--no-rvq-cb-order`, in
> `src/cli.ts` + `src/encode.ts`/`src/rvq.ts`), e dall'ondata 2 gli item 1 e 3
> (`--scale-stages` → `vq_scale_s*` in `src/encode.ts`/`src/decode.ts`;
> `--no-positions`/`--no-opacity`/`--no-rotation`/`--no-scale`, inclusi i
> default "canale assente" nel decoder). Vedi `README.md` "Flag parity" per
> lo stato per-flag verificato. Le righe sotto restano valide per **il resto**
> (non ancora portato): `--dc-kmeans`/`--sh-kmeans`/`--load-vq`, `--rot-split`,
> `--sort-mode nn`, `--sort-metric bits`, `--pos-joint`, `--sh-whiten`,
> `--legacy-tail`, `--save-vq`, `--cb-float`, `vq_sh1/2/3_s*` (banded legacy).

- **`easter_codec.cpp/.h` — codice morto.** Incluso da `ply_to_bek.cpp:20` e `bek_to_ply.cpp:14` ma `quantize_easter`/`dequantize_easter` non sono **mai chiamate**. Omettere del tutto, insieme a `pack_integer_effective_bytes*` / `unpack_integer_effective_bytes_i16` (usate solo da lì) e `byte_shuffle_16` (mai usata).
- `tinyply.h` (988 righe): rimpiazzato da un lettore/scrittore PLY binary-LE minimale (~150 righe totali). Vedi §4.
- `quantization`: `quantize_position_spz` (non-zz), `pack/unpack_quaternion_smallest_three` (32-bit), `_24` (superata da `_var` con `mag_bits=6`, bit-identica), `_split` + `unpack_..._split` (solo `--rot-split`), `quantize_to_u16_levels`/`dequantize_from_u16_levels` (mai usate).
- `sh_vq`: `compute_vq`, `train_vq`, `assign_vq` (solo `--dc-kmeans`/`--sh-kmeans`/`--load-vq`).
- `ply_reader`: `greedy_nn_order` (~90 righe, solo `--sort-mode nn`), `bitlen32` + `cost_bits` (solo `--sort-metric bits`).
- `range_coder`: `posmag3_encode/decode` (solo `--pos-joint`).
- `bek_to_ply`: rami `km_dc`, `km_sh_ac`, `vq_sh1/2/3_s*` (banded, formato legacy), `rotation_idx`/split — **non** portati. `vq_scale_s*` e i default "canale assente" (opacità/rotazione/scala) **sono** stati portati (vedi nota sopra).
- **WebP encode**: vedi §4.2.

### 1.3 Struttura dati che attraversa encoder → decoder

Container `BEK3` (little-endian ovunque):

```
[0..4)    magic ASCII "BEK3"
[4..12)   uint64 LE  uncompressed_size
[12..EOF) frame zstd  --decomprime-->  buffer non compresso:
                                        [0..4)      uint32 LE header_size
                                        [4..4+hs)   CBOR (nlohmann to_cbor)
                                        [4+hs..end) payload = blob dei canali concatenati
```

Header CBOR (mappa root, 4 chiavi, ordinate lessicograficamente: `channels`,`count`,`height`,`width`):

```
count  : uint  N
width  : uint  ceil(sqrt(N))
height : uint  ceil(N / width)
channels : [ { channels:uint, meta:{...}, name:tstr, offset:uint, size:uint } ]  // chiavi ordinate
```

`meta` per canale al default (chiavi sempre ordinate lessicograficamente):

| canale | ch | meta |
|---|---|---|
| `opacity` | 1 | `bits:8, codec:"…", type:"sigmoid"` |
| `pos_x/y/z` | 3 | `bits:24, codec:"…", frac:9, type:"spz_dpcm_zz"` |
| `rotation` | 3 | `bits:24, codec:"…", mag_bits:6, type:"smallest3_24"` |
| `scales` | 3 | `codec:"…", max:[f32x3], min:[f32x3], type:"u8_levels"` |
| `vq_dc_s{0,1}` | 1 | `cb_indices:[u8x768], codec:"…", levels:[f32x256], stage:s, type:"rvq_stage_quantized"` (+`ctx_ch` se `rcx`) |
| `vq_sh_ac_s{0,1,2}` | 1 | `cb_indices:[u8x11520], codec:"…", dims:45, levels:[f32x256], stage:s, type:"rvq_stage_sh_ac_quantized"` (+`ctx_ch`) |

Il decoder ricostruisce il codebook come `codebook[e] = levels[cb_indices[e]]` e **accumula** gli stage RVQ (`+=`).

---

## 2. Decisione sulla bit-exactness

### Raccomandazione: **NO alla byte-identity del `.bek` finale. SÌ alla byte-identity del buffer pre-zstd.**

| livello | definizione | stato |
|---|---|---|
| **L1** *(obbligatorio)* | Il `.bek` TS è decodificato correttamente da `bek_to_ply` C++, e il `.bek` C++ è decodificato dal decoder TS producendo il **PLY byte-identico** a quello del decoder C++. | Sempre raggiungibile. |
| **L2** *(strumento di debug)* | Il **buffer non compresso** (header CBOR + payload) prodotto da TS è **byte-identico** a quello C++ sullo stesso input. | Raggiungibile **solo su input privi di tie Morton** (es. `tiny.ply`). Non è il contratto di produzione — vedi rischio 2. |
| **L2′** *(contratto sulle scene reali)* | Stesso set di canali, stessa scelta di codec per canale, `meta` identico salvo i valori che dipendono dall'ordine, dimensione di ogni blob entro ±0.5%, e L1 pieno. | Obiettivo contrattuale su `room_low.ply` e oltre. |
| **L3** *(fuori scope)* | Il file `.bek` finale è byte-identico. | **Impossibile per costruzione.** |

**Perché L3 è impossibile — non è un limite di TypeScript, è un limite del C++ stesso.**
`ply_to_bek.cpp:720-724` imposta `ZSTD_c_nbWorkers = std::thread::hardware_concurrency()`. Il commento nel sorgente lo ammette: *"compressed bytes may differ marginally from the single-thread output (job boundaries)"*. L'encoder C++ non produce output riproducibile fra macchine con numero di core diverso. In più `node:zlib` usa la libzstd bundled di Node.

**Perché L2 è il target giusto:** se header CBOR + payload coincidono byte per byte, allora quantizzazione, ordinamento, k-means, RVQ, Lloyd, chain-order, scelta best-of e range coder sono tutti esatti.

**I tre moduli che rendono L2 difficile** — tutti verificati, nessuno divergente:

1. **`sh_vq.cpp:47-51` — `std::mt19937(0)` + `std::uniform_int_distribution<int>`.** `uniform_int_distribution` è implementation-defined (libc++ su macOS). Contromisura in §3.9. → **CHIUSO in F3: probe C++ (`test/probe_subset.cpp`) e implementazione TS producono la stessa sequenza di `subset_indices`.**
2. **`ply_reader.cpp:305-307` — `std::sort` su chiavi Morton duplicate.** `std::sort` non è stabile; `Array.prototype.sort` lo è. Contromisura in §3.3. → **NON risolvibile a costo ragionevole. Misurato: 0 tie su `tiny.ply` (20k), ma 6 gruppi in tie su `room_low.ply` (1.13M), con righe PLY tutte diverse fra loro** — quindi il tie-break è osservabile nell'output. Replicare l'introsort di libc++ è fragile e non vale il costo. **Conseguenza: L2 vale solo su input verificati privi di tie; sulle scene reali il contratto è L1 + L2′.**
3. **WebP sui tre canali `vq_sh_ac_s*`** (§4.2). → **CHIUSO in F0b: `cwebp -lossless -m 4 -q 100 -exact` riproduce i blob del C++ byte per byte su tutti e tre.** Se Homebrew aggiorna `webp`, ricompilare il riferimento C++ e rigenerare i `.bek` prima di rieseguire F5.

**Verifiche indipendenti già eseguite su scene grandi** (non solo su `tiny.ply`): range coder — 8/8 blob byte-identici su `room` (1.59M splat) e 13/13 su `garden` (5.83M), ~87 MB senza una differenza; container — `.bek` riassemblato con lo zstd di Node e decodificato da `bek_to_ply` C++ → PLY da 395 MB byte-identico (e lo zstd single-thread di Node è risultato 175 byte più piccolo di quello multi-thread del C++, conferma sperimentale che L3 è mal posto).

---

## 3. Trappole numeriche — elenco con contromisura precisa

### 3.1 Range coder: `low` è uint64 — **non serve BigInt**

`range_coder.cpp:19-30`. Dopo ogni `shift_low()`, `low` è mascherato a 32 bit; `low += bound` con `bound < 2^32` ⇒ **`low < 2^33` < 2^53**. Sta in un `number`.

```ts
// low: number, invariante 0 <= low < 2^33
shiftLow() {
  if ((this.low >>> 0) < 0xFF000000 || this.low >= 0x100000000) {
    const carry = this.low >= 0x100000000 ? 1 : 0;   // (low >> 32) è 0 o 1
    let temp = this.cache;
    do { this.out.push((temp + carry) & 0xFF); temp = 0xFF; } while (--this.cacheSize !== 0);
    this.cache = (this.low / 0x1000000) & 0xFF;      // (low >> 24) & 0xFF
  }
  ++this.cacheSize;
  this.low = (this.low % 0x100000000) * 256 % 0x100000000;
}
```

- `this.low >>> 0` tronca a 32 bit: è **esattamente** `static_cast<uint32_t>(low)`. Non sostituirlo con `this.low < 0xFF000000`.
- `(low << 8) & 0xFFFFFFFF` **non** si scrive con `<<`: `low` può superare 2^32 e `<<` in JS tronca a int32 con segno. Usare `* 256 % 0x100000000`.
- `range` uint32 → `range = (range << 8) >>> 0`; `bound = ((range >>> 11) * prob) >>> 0` (**non** `Math.imul`); `code = ((code << 8) | b) >>> 0`. Confronti con entrambi normalizzati `>>>0`.
- Tabelle `probs`: `Uint16Array`, allocata una volta per chiamata.

### 3.2 `__builtin_clz` → `Math.clz32`

`range_coder.cpp:274` e `:344`: `nbits = zz ? (32 - __builtin_clz(zz)) : 0` → `nbits = zz ? 32 - Math.clz32(zz) : 0`.

### 3.3 Ordinamento Morton: 63 bit > 2^53, e `std::sort` non è stabile

`ply_reader.cpp:98-110`: `encode_morton` produce fino a 63 bit — **non rappresentabile in un double**. Calcolare come due metà a 32 bit (hi/lo su `Uint32Array`) e ordinare gli indici con comparatore esplicito:

```ts
idx.sort((a, b) => (hi[a] !== hi[b] ? (hi[a] < hi[b] ? -1 : 1)
                  : lo[a] !== lo[b] ? (lo[a] < lo[b] ? -1 : 1) : 0));
```

`idx` deve essere un **`Array<number>` normale**. Con `return 0` sui pari, `Array.sort` (stabile) mantiene l'ordine originale; `std::sort` no. **Per L2 verificare quanti codici Morton duplicati ci sono** sull'input di test: se zero, il problema non esiste. Se non è zero, documentare come divergenza accettata (L2′).

Coordinate di griglia (`ply_reader.cpp:295-297`) mescolano float e double:
```cpp
uint32_t ix = static_cast<uint32_t>((x[i] - min_x) / range_x * MORTON_MAX);
//                                   float-float=float / float=float * double=DOUBLE, poi troncamento
```
In TS: `Math.trunc(Math.fround(Math.fround(x[i] - minX) / rangeX) * 2097151.0)`. Il `fround` sulla divisione **serve**; il `* MORTON_MAX` **non** va frounded. `static_cast<uint32_t>` da double = troncamento verso zero → `Math.trunc`.
`range_x = std::max(max_x - min_x, 1e-6f)` → `Math.max(Math.fround(maxX - minX), Math.fround(1e-6))`.

### 3.4 float32 vs float64: dove serve `Math.fround`

Regola: **ogni variabile che in C++ è `float` deve essere frounded a ogni operazione**.

- **`sh_vq.cpp:14-28` `compute_dist_sq`** — loop più caldo, determina un `argmin`. Un errore ULP cambia l'assegnazione → codebook diverso → payload diverso.
  ```ts
  let dist = 0;                       // rappresenta un float
  for (let d = 0; d < dims; ++d) {
    const diff = Math.fround(a[ao + d] - b[bo + d]);
    dist = Math.fround(dist + Math.fround(diff * diff));
  }
  ```
  Il ramo con `w` (whitening) non serve al default (`weights` vuoto ⇒ L2 puro). Implementare **solo** quello.
- **`sh_vq.cpp:99-113` accumulo centroidi** — se `newCodebook` è una `Float32Array`, `nc[i] += v` fa read(f32)→add(f64)→store(f32): **combacia col C++**. Non aggiungere `fround` manuale. Idem `codebook[c*dims+d] = newCodebook[...] / counts[c]`.
- **`sh_vq.cpp:291-355` `quantize_scalar_lloyd`** — `levels` e `data` float; `dmin + (dmax-dmin) * (i/(num_levels-1))` con `static_cast<float>(i)`. `levels` in `Float32Array`, froundare l'inizializzazione. `std::abs(data[i]-levels[l])` → `Math.abs(Math.fround(...))`. Convergenza `> 1e-6` su float.
- **`ply_reader.cpp:313-315` `cost_l1`** — ritorna `float`, somma di tre `fabs` float, valutata da sinistra:
  ```ts
  const costL1 = (a,b) => Math.fround(Math.fround(
      Math.abs(Math.fround(x[a]-x[b])) + Math.abs(Math.fround(y[a]-y[b]))) +
      Math.abs(Math.fround(z[a]-z[b])));
  ```
  In `refine_2opt`: `const delta = Math.fround(Math.fround(cac + cbd) - Math.fround(dab + ccd));` confrontato con `bestDelta` inizializzato a `Math.fround(-1e-6)`.
- **`quantization.cpp` — quaternioni e posizioni: tutto in `double`.** `double q[4] = { rot_0[i], ... }` promuove a double. Qui `fround` **non va messo** (a parte la lettura dalla `Float32Array`). Non sovra-froundare.
- **`quantize_to_u8_levels` (`quantization.cpp:375-396`)** — `out_min`/`out_max` sono `double&` assegnati da `float`, poi tutto in double. Questi valori finiscono in `meta.min/max` e nel CBOR sono scritti come **float32** (`0xfa`).

### 3.5 `std::round` ≠ `Math.round`

`std::round` è *half away from zero*; `Math.round` è *half toward +∞*.

- **`quantization.cpp:122` `std::round(data[i] * scale)`** — `data[i]` può essere negativo. **Obbligatorio:**
  ```ts
  const cRound = (v: number) => Math.sign(v) * Math.round(Math.abs(v));
  ```
- `quantization.cpp:146` `std::round(sigmoid * 255.0)`: ≥0, ma usare `cRound` per uniformità.
- `quantization.cpp:392` `std::round(normalized * levels)`: `normalized ∈ [0,1]`.
- **`quantization.cpp:292` è `std::floor(max_mag * x + 0.5)`, non `round`** → `Math.floor(...)`.

### 3.6 Aritmetica intera a 24 bit e cast da int64

`quantization.cpp:122-131`:
```cpp
int64_t fixed32 = std::round(data[i] * scale);
uint32_t cur_q = static_cast<uint32_t>(fixed32) & 0xFFFFFF;
```
`>>> 0` in JS tronca male se |fixed32| ≥ 2^32. Usare aritmetica modulare su double:
```ts
const mod24 = (v: number) => v - Math.floor(v / 0x1000000) * 0x1000000;  // [0, 2^24)
const curQ = mod24(fixed32);
const delta24 = (curQ - prevQ) & 0xFFFFFF;
let d = delta24; if (d & 0x800000) d -= 0x1000000;   // sign-extend a 24 bit
const zz = ((d << 1) ^ (d >> 31)) & 0xFFFFFF;        // <<,>> su int32: identici al C++
```
`d >> 31` deve essere **`>>`** (aritmetico), non `>>>`.

Decoder (`quantization.cpp:448`): `int32_t d = (zz >> 1) ^ -(zz & 1)` → `(zz >>> 1) ^ -(zz & 1)`. Poi `(prevQ + d) & 0xFFFFFF`.

### 3.7 Indici uint32 e overflow di `size_t`

- `rc2_context` ∈ `[0, 8192)`, `<< 8` → max 2^21: nessun overflow int32.
- `probs[ctx << 8]` con `ctx` ≤ 8191 → indice max 2 097 152, dentro `Uint16Array`.
- **Offset payload**: `number` normali; in `container.ts` `readBigUInt64LE`/`writeBigUInt64LE` solo per `uncompressed_size`, convertito con `Number()` verificando `<= Number.MAX_SAFE_INTEGER`.
- **Tutte** le letture/scritture binarie con `readUInt32LE`/`writeUInt32LE`. Mai `Uint32Array` su buffer non allineato: `new Uint32Array(buffer, byteOffset, n)` richiede `byteOffset % 4 === 0` e i `Buffer` Node sono slice di un pool. Usare `DataView` o `Buffer.readXxx`.

### 3.8 Ordinamento dei canali e determinismo

`ply_to_bek.cpp:536` ordina i canali per nome (`std::string` byte-wise). Nomi distinti ⇒ nessun problema di stabilità. In TS: `channels.sort((a,b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)`. **Non usare `localeCompare`**.

Il C++ usa `std::async` ma il risultato è deterministico. Il port TS può essere **sequenziale** senza cambiare l'output.

Nel best-of (`ply_to_bek.cpp:652-675`) i pareggi contano: `std::min({pmag, rpk, rcx, rc2, rc1, webp, raw})` seguito da una catena `if (best == …)`. **Replicare esattamente l'ordine di priorità** `posmag → rotpack → rcx → rc2 → rc1 → webp → raw`, con `Number.MAX_SAFE_INTEGER` come `SIZE_MAX` per i candidati assenti.

### 3.9 `std::mt19937` + `std::uniform_int_distribution` (libc++)

`sh_vq.cpp:46-51`:
```cpp
std::mt19937 rng(0);
for (int i = 0; i < sample_size; ++i) {
    std::uniform_int_distribution<int> dist(i, num_points - 1);
    std::swap(subset_indices[i], subset_indices[dist(rng)]);
}
```
MT19937 seed 0: ~40 righe di TS, verificabile contro i test vector noti.

`uniform_int_distribution` su libc++ per `[a,b]` con engine a 32 bit:
```
Rp = b - a + 1
if Rp == 1 return a
w = 32 - clz32(Rp) - 1
if ((Rp & (0xFFFFFFFF >>> (32 - w))) != 0) ++w
do { u = <w bit dal motore> } while (u >= Rp)
return u + a
```
Per mt19937 (range pieno a 32 bit) `<w bit>` si riduce ai **w bit bassi di una singola estrazione** — ma questa riduzione **va verificata, non assunta**.

**Contromisura verificabile (F3):** probe C++ di 15 righe che stampa i primi 200 valori di `subset_indices` per il `num_points` del PLY di test, confrontato con l'output TS. Se combaciano, L2 è a portata; se no, si scala a L2′.

`sample_size = min(35000, max(5000, static_cast<int>(num_points * 0.10)))` — troncamento di un double → `Math.trunc(numPoints * 0.10)`, **non** `Math.round`.

### 3.10 CBOR: replicare la canonicalizzazione di nlohmann

Verificato sui byte reali di un `.bek`:

- **Chiavi delle mappe ordinate lessicograficamente byte-wise** (`std::map`). Root: `a4` + `channels`,`count`,`height`,`width`. Entry canale: `a5` + `channels`,`meta`,`name`,`offset`,`size`. **Non è il canonical CBOR RFC 8949** (che ordina prima per lunghezza) — è ordinamento lessicografico puro.
- **Float: `0xFA` (float32) quando il round-trip `double→float→double` è esatto, altrimenti `0xFB`.** `Math.fround(v) === v ? emitF32(v) : emitF64(v)`, con `DataView.setFloat32`.
- **Interi: codifica minimale** (0..23 inline, poi `0x18`/`0x19`/`0x1A`/`0x1B`).
- **Stringhe: `tstr` UTF-8** con lunghezza minimale.
- **Array di byte (`cb_indices`)**: nlohmann serializza `std::vector<uint8_t>` come **array CBOR di uint**, non come `bstr`. **Non ottimizzare in `bstr`**: romperebbe L1 col decoder C++.

### 3.11 zstd — parametri e verifica

Verificato su Node v26.3.0: `zlib.zstdCompressSync` accetta `params`.

```ts
import { zstdCompressSync, zstdDecompressSync, constants as C } from 'node:zlib';
const comp = zstdCompressSync(buf, { params: {
  [C.ZSTD_c_compressionLevel]: 22,
  [C.ZSTD_c_enableLongDistanceMatching]: 1,
  [C.ZSTD_c_windowLog]: 27,
}});
const raw = zstdDecompressSync(frame, {
  params: { [C.ZSTD_d_windowLogMax]: 31 },
  maxOutputLength: uncompressedSize,
});
```

- **`maxOutputLength` è obbligatorio in decompressione**: il default di Node è ~64MB e i buffer BEK lo superano.
- **Non impostare `nbWorkers`**: è la causa principale della non-riproducibilità.

### 3.12 PLY: lettura float32 e ordine dei campi

`read_ply` (`ply_reader.cpp:57-65`) accetta **solo** proprietà `FLOAT32`, e prende `count` da `x`. Il reader TS deve fallire esplicitamente su PLY con proprietà `double`/`uchar` per le colonne richieste (validazione al confine di fiducia — non semplificare via).

`write_ply_file` (tinyply, binario LE) emette in quest'ordine fisso: `x,y,z,nx,ny,nz` (normali sempre a zero), `f_dc_0..2`, `f_rest_0..44`, `opacity`, `scale_0..2`, `rot_0..3` = 62 proprietà float32 = 248 byte/vertice. L'header tinyply va replicato **carattere per carattere** per poter fare il diff byte-a-byte contro l'output di `bek_to_ply`.

---

## 4. Strategia dipendenze

**Zero dipendenze npm runtime.** Solo `typescript` in `devDependencies`.

| serve | soluzione |
|---|---|
| zstd | `node:zlib` nativo (verificato su v26.3.0) |
| JSON | nativo (solo logging) |
| CBOR | `src/cbor.ts`, ~250 righe enc+dec. Nessun pacchetto npm replica la canonicalizzazione nlohmann. |
| PLY | `src/ply.ts`, ~150 righe |
| WebP | `cwebp`/`dwebp` di Homebrew via `child_process` (`src/webp.ts`, ~45 righe). **Nessuna dipendenza npm; prerequisito di sistema `brew install webp`, stessa versione linkata dal riferimento C++.** |

### 4.1 PLY: perché non `@playcanvas/splat-transform`

Esporta `readPly`/`writePly`, ma tirarlo dentro significa `playcanvas` (peer, enorme) + `webgpu` + `@adobe/spz`, e un modello dati (`DataTable`, `Transform`) che può normalizzare/riordinare i valori. Per "header di testo + blocco di float32 LE" un reader dedicato di ~80 righe è più piccolo dell'adattatore. Resta il riferimento per lo *stack* (ESM, TS, `bin/cli.mjs`).

### 4.2 WebP: **shell-out a `cwebp`/`dwebp`** — encode e decode

**L'assunzione "WebP non vince mai" era FALSA al punto di default.** Misurato in F0 con `dc_stages 2 / sh_stages 3 / pos_bits 9`, sia su 20k splat sia su `room_low.ply` (1.13M):

```
vq_sh_ac_s0 -> webp     opacity, pos_x/y/z, rotation, scales,
vq_sh_ac_s1 -> webp     vq_dc_s0, vq_dc_s1 -> rc1 / posmag / rotpack
vq_sh_ac_s2 -> webp
```

I `.bek` ispezionati in precedenza erano di combinazioni **non** default. WebP vince su tutti e tre i piani di indici SH-AC. Inoltre WebP serve **comunque in decodifica**: senza, il decoder TS non legge un `.bek` prodotto dal C++, cioè non esiste nemmeno L1.

**Soluzione: i binari CLI di Homebrew, invocati come sottoprocessi.**

`otool -L build/ply_to_bek` mostra `/opt/homebrew/opt/webp/lib/libwebp.7.dylib`; `cwebp -version` è `1.6.0`. **Stessa libreria, stesso codice di encoding**: la bit-exactness è per costruzione. Nessuna dipendenza npm; un prerequisito di sistema (`brew install webp`), già necessario per compilare il riferimento C++, da dichiarare nel README.

**Riga di comando — VERIFICATA (F0b), non assunta:**

```
cwebp -lossless -m 4 -q 100 -exact -quiet -o <out.webp> -- <plane.ppm>
```

`ply_to_bek.cpp:35-66` fa `WebPConfigInit` -> `WebPConfigLosslessPreset(&config, 6)` -> `config.quality = 100` -> `config.exact = 1`, resto default (`thread_level = 0`). Il preset tocca solo `lossless`, `method`, `quality`, e `quality` viene poi sovrascritto ⇒ config effettiva `lossless=1, method=4, quality=100, exact=1`. Il probe F0b ha girato la griglia `-m 0..6` × `{-exact, ø}` sul blob reale di `vq_sh_ac_s0` estratto da `/tmp/ref_tiny.bek`: **unico MATCH a `-m 4`** (le altre method danno 17098..18816 byte contro i 17348 del riferimento). Confermato byte-identico anche su `vq_sh_ac_s1` e `vq_sh_ac_s2`. **`-m 4` è congelato; non cambiarlo senza rieseguire il probe.**

**Input.** Il C++ costruisce un piano `W × H` con `W = ceil(sqrt(N))`, `H = ceil(N / W)`, padding a zero fino a `W*H*ch`, e per `ch == 1` replica il byte su R,G,B. In TS lo stesso piano si passa a `cwebp` come **PPM P6** (`"P6\n{W} {H}\n255\n"` + `W*H*3` byte): `pnmdec` di libwebp chiama `WebPPictureImportRGB`, esattamente come il C++. Per `ch == 4` (mai al default) servirebbe PAM; non implementare.

**Skip list — da replicare alla lettera** (`ply_to_bek.cpp:580-584`): niente candidato WebP per `rotation`, `scales`, `opacity`, `vq_dc_s0`. Ometterla è un bug: un WebP vincente su un canale dove il C++ non l'ha nemmeno provato cambia il codec scelto. I candidati WebP effettivi al default sono **7**: `pos_x/y/z`, `vq_dc_s1`, `vq_sh_ac_s0/1/2`.

**Decode.** `bek_to_ply.cpp:127-142` usa `WebPDecodeRGBA` e legge `w*h` pixel prendendo RGB (`ch==3`), R (`ch==1`), RGBA (`ch==4`). Equivalente: `dwebp <blob> -ppm -o -`, poi si scartano i byte oltre `N*ch`. Il decode VP8L lossless è esatto per specifica: nessuna dipendenza dalla versione di libwebp. Il ramo `else` del dispatch resta **webp** anche per `codec` assente, come in C++ (`m.value("codec", "webp")`).

**I/O.** File temporanei in `os.tmpdir()`, oppure `-` se `cwebp`/`dwebp` accettano stdin/stdout. Dettaglio implementativo. I 7 encode girano **in parallelo** (`child_process.execFile` + `Promise.all`), come lo `std::async` del C++: output indipendente per canale, quindi deterministico.

**Fallback, se un giorno il probe smettesse di combaciare** (es. Homebrew aggiorna `webp` e il riferimento C++ non viene ricompilato): addon N-API che linka `/opt/homebrew/lib/libwebp.a` e chiama `WebPEncode` con la `WebPConfig` esatta. Ultimo ripiego dichiarato: **L2′ sui tre canali SH-AC** (§2).

**Scartate:** il wasm di `@playcanvas/splat-transform` (`lib/webp.mjs`) esporta solo `webp_encode_rgba`, `webp_encode_lossless_rgba`, `webp_decode_rgba`, `webp_free` — l'API avanzata non è raggiungibile e `WebPEncodeLosslessRGBA` usa quality 70/exact 0: mai bit-esatto. Resta piano B per il **solo decode** senza Homebrew (352 KB vendorabili, MIT). Build wasm custom: richiede emscripten (assente) e la contrazione FMA di clang su arm64 rende la bit-exactness incerta anche dopo. Encoder VP8L in TS: migliaia di righe, bit-exactness impossibile.

---

## 5. Prestazioni: dove sta il costo

**Il collo di bottiglia non è il range coder. È il k-means.**

| hot spot | ordine di grandezza (N ≈ 1.1M) | note |
|---|---|---|
| **`train_vq_optimized` SH-AC** | 3 stage × 30 iter × 35 000 campioni × 256 cluster × 45 dim ≈ **3.6e10** mul-add f32 | C++ multithread + vettorizzato |
| **`assign_vq_optimized` SH-AC** | 3 stage × 1.1M × 256 × 45 ≈ **3.8e10** | stessa scala |
| **`refine_2opt`** | 4 pass × N × 128 finestra × 3 `cost_l1` ≈ **1.7e9** | in JS: secondi-minuti |
| range coder | ~21 byte/splat × 2 candidati × 8 bit ≈ **4e8** `encode_bit` | un ordine sotto |
| **`cwebp -lossless -m 4` × 7 canali** | 7 × W·H pixel | fuori processo, in parallelo. Non è il collo di bottiglia. |

1. **`Float32Array` ovunque, layout interleaved come il C++.** Nessun `number[]`, nessuna allocazione dentro i loop: `codebook`, `subset`, `newCodebook`, `counts` (`Int32Array`), `labels` (`Int32Array`) allocati fuori dal loop.
2. **`compute_dist_sq` inlinata a mano** nel loop di assegnazione, ramo `weights` eliminato. Firma monomorfa.
3. **`Math.fround`** è un'intrinseca in V8. **Non è negoziabile** — vedi §3.4.
4. **`worker_threads` per k-means**, solo se F5 mostra che serve. Il C++ parallelizza l'assegnazione con lo stesso chunking e riduzione seriale ⇒ deterministico. `SharedArrayBuffer` per `subset` e `codebook`.
5. **Range coder**: `out` come `Uint8Array` pre-allocata (crescita ×2), non `Array.push`. `probs` allocate una volta per chiamata.
6. **`refine_2opt`**: `order` come `Uint32Array`; `std::reverse` su un range = swap in-place a due indici; nessuna closure nel loop interno.
7. **Memoria**: `room_low.ply` (280MB) ≈ 1.1M splat ⇒ `f_rest` ~200MB + copia interleaved ~200MB. `room.ply`/`garden.ply` richiedono `--max-old-space-size` alzato. Documentare, non progettare per lo streaming.

Aspettativa realistica: **5-15× più lento del C++**. Dichiararlo nel README.

---

## 6. Albero file

```
bek-ts/
├── package.json           # type:module, bin:{bek:"./dist/cli.js"}, deps:{}, devDeps:{typescript}
├── tsconfig.json          # target ES2022, module NodeNext, strict, outDir dist
├── README.md              # punto operativo, livello di equivalenza dichiarato (L1/L2), limiti
├── DESIGN.md              # questo documento
└── src/
    ├── cli.ts             # bek encode <in.ply> <out.bek> | bek decode <in.bek> <out.ply>
    ├── ply.ts             # readPly / writePly (binary LE, float32, layout tinyply)
    ├── order.ts           # part1by2, encodeMorton(hi/lo), sortMorton, refine2opt+costL1
    ├── quantize.ts        # posSpzZz ±, opacitySigmoid ±, quatSmallest3Var ±, u8Levels ±
    ├── rvq.ts             # mt19937+uniformInt, trainVq, assignVq, reorderCodebookChain,
    │                      # computeRvq, quantizeScalarLloyd, packRvqPooled
    ├── rangecoder.ts      # RangeEncoder/Decoder, rc1/rc2/rcx/posmag/rotpack (enc+dec)
    ├── cbor.ts            # encodeCbor (canonico nlohmann) / decodeCbor
    ├── webp.ts            # shell-out cwebp/dwebp (PPM P6), ~45 righe
    ├── container.ts       # writeBek / readBek (magic, uint64, zstd, header, offsets)
    ├── encode.ts          # pipeline ply -> canali -> best-of -> container
    └── decode.ts          # pipeline container -> canali -> attributi -> ply
└── test/
    ├── vectors.ts         # self-check: range coder round-trip, cbor, quantize, mt19937
    └── roundtrip.ts       # ply -> bek -> ply, cross-check contro i binari C++
```

12 file sorgente. Nessuna cartella `utils/`, nessuna astrazione `Codec` con una sola implementazione, nessun sistema di plugin: i 5 codec sono uno `switch` in `encode.ts`/`decode.ts`, come in C++.

---

## 7. Fasi di implementazione, con criterio di verifica eseguibile

### F0 — Ricognizione (nessun codice TS)
Girare l'encoder C++ **con i flag di default** su un input piccolo, e ispezionare l'header.
**Criterio:** confermare (a) i **11 canali** attesi, (b) **nessun canale usa `webp`**, (c) contare i codici Morton duplicati.
→ Se (b) è falso, aggiungere la build wasm libwebp al piano. Se (c) > 0, dichiarare L2′.
Creare qui `data/tiny.ply` (~20k splat): tutte le fasi successive iterano su quello.

### F1 — `ply.ts`
**Criterio:** `readPly(tiny.ply)` → `writePly` → `cmp` byte-a-byte con l'originale. E: decodificare `ref_tiny.bek` con `bek_to_ply` C++, poi `readPly`+`writePly` di quel risultato → `cmp` identico (valida il layout tinyply a 62 proprietà).

### F2 — `cbor.ts`
**Criterio:** estrarre l'header CBOR da `ref_tiny.bek`, `decodeCbor` → `encodeCbor` → **`cmp` byte-a-byte con l'originale**. Verifica in un colpo ordinamento chiavi, interi minimali e regola float32/float64.

### F3 — `rvq.ts`, solo RNG e Lloyd
**Criterio:** probe C++ di 15 righe che stampa i primi 200 `subset_indices` per `num_points` di `tiny.ply`; confronto con l'output TS. **Se diverge, fermarsi e decidere L2 vs L2′** prima di scrivere il resto.

### F4 — `rangecoder.ts`
**Criterio (due parti):**
(a) *self-check*: per ogni codec, `decode(encode(buf)) === buf` su dati casuali e pattern degeneri (tutti zero, tutti 0xFF, N=0, N=1).
(b) *cross-check*: estrarre il payload di `ref_tiny.bek`, e per ogni canale ri-encodare i byte grezzi (dal `decode` TS) e verificare **`cmp` byte-a-byte con il blob originale del C++**.

### F5 — `order.ts` + `quantize.ts` + `rvq.ts` completo + `webp.ts`
**Criterio:** encoder TS parziale che si ferma **prima** dello zstd e scrive il buffer non compresso; `cmp` byte-a-byte contro il buffer non compresso estratto da `ref_tiny.bek`. **Questo è il test L2.** La posizione del primo byte diverso individua il modulo colpevole.
Qui si misurano i tempi e si decide se servono i `worker_threads`.

### F6 — `container.ts` + `encode.ts` + `cli.ts`
**Criterio (L1, TS→C++):**
```bash
node dist/cli.js encode data/tiny.ply /tmp/ts.bek
./build/bek_to_ply /tmp/ts.bek /tmp/from_ts.ply
./build/ply_to_bek data/tiny.ply /tmp/ref.bek && ./build/bek_to_ply /tmp/ref.bek /tmp/from_cpp.ply
cmp /tmp/from_ts.ply /tmp/from_cpp.ply      # deve passare
```
Più: dimensione di `/tmp/ts.bek` entro ±1% di `/tmp/ref.bek`.

### F7 — `decode.ts`
**Criterio (L1, C++→TS):**
```bash
node dist/cli.js decode /tmp/ref.bek /tmp/ts_out.ply
cmp /tmp/ts_out.ply /tmp/from_cpp.ply       # deve passare
node dist/cli.js decode /tmp/ts.bek /tmp/ts_ts.ply
cmp /tmp/ts_ts.ply /tmp/from_cpp.ply        # round-trip TS puro
```

### F8 — Validazione su scala reale
Ripetere F5, F6, F7 su `data/room_low.ply` (280MB).
**Criterio: L2′** — L2 pieno NON è atteso qui, perché `room_low.ply` ha 6 gruppi di codici Morton in tie e il tie-break di `std::sort` non è replicabile (§2, rischio 2). Accettazione: stesso set di 11 canali, stessa scelta di codec per canale, dimensione di ogni blob entro ±0.5%, `size(ts.bek)/size(ref.bek) ≤ 1.01`, e **L1 pieno in entrambe le direzioni** (che resta obbligatorio e non ammette deroghe). Ricontare i tie Morton e registrarlo nel README insieme al tempo di encode.

---

## 8. Riepilogo delle decisioni

1. **Bit-exactness: L2 (buffer pre-zstd byte-identico), non L3.** L3 è impossibile: l'encoder C++ usa zstd multi-thread con `nbWorkers = hardware_concurrency`.
2. **Zero dipendenze npm.** zstd nativo, CBOR e PLY scritti in casa (~400 righe).
3. **WebP incluso, via shell-out a `cwebp`/`dwebp` 1.6.0** — la stessa libwebp linkata dal binario C++, quindi bit-esatto per costruzione (verificato in F0b su 3/3 canali). Vince su `vq_sh_ac_s0/1/2` al punto di default. Fallback: addon N-API; ripiego dichiarato: L2′ sui tre canali.
4. **`easter_codec` è codice morto** — mai chiamato. Non portarlo, e con esso cadono `pack_integer_effective_bytes*` e `byte_shuffle_16`.
5. **`low` del range coder sta in un `number`** (< 2^33 < 2^53): niente BigInt.
6. **I due soli rischi per L2** sono `std::uniform_int_distribution` di libc++ e il tie-break di `std::sort` sui Morton duplicati. Entrambi si chiudono in F0/F3.
