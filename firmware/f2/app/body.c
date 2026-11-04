/* body.c — ver body.h. Los nombres de Cuerpo.kt van entre paréntesis donde ayudan a seguir el puerto. */
#include "body.h"

#include <stdio.h>
#include <string.h>

#include "app.h"
#include "cJSON.h"
#include "f2_hal.h"
#include "perception.h"

#define ID_LEN    48
#define KIND_LEN  20
#define DATA_LEN  80
#define FROM_LEN  12
#define META_MAX  (BODY_LOG_MAX * 240 + 16)
#define HELLO_RING 8
#define RECV_KEEP  4
#define ACKQ       4
#define T_NEVER    (INT64_MIN / 4)

/* Un evento importante con id único (5.6) */
typedef struct {
    char id[ID_LEN], kind[KIND_LEN], data[DATA_LEN], from[FROM_LEN];   /* data: objeto JSON; from: recuerdo_de */
    double at;
    uint32_t since;    /* seq al entrar a la memoria: lo cubre el primer respaldo aceptado con bseq > since */
    uint8_t meta;      /* llegó en el paquete del otro cuerpo: ya está respaldado (respaldada) */
    uint8_t pending;   /* por recuperar tras perder el turno (pendientes) */
    uint8_t ack;       /* evento del servidor aplicado aquí (acuses; regla 4: solo si sigue en la memoria) */
} body_ev;

static struct {
    uint32_t n, seq, seq_res, tag, acked_bseq, ev_k, move_k;
    int proto, copy, activo, link, night, want_hello, applying, warned;
    int64_t lease_until, turn_ms, next_hello, next_backup, night_since;
    int next_nonce, hello_i, recv_i;
    struct { int nonce; int64_t sent; int ev_all; } hello[HELLO_RING];   /* cuándo se MANDÓ cada hello (5.7) */
    char recv[RECV_KEEP][ID_LEN];                                         /* mudanzas ya recibidas (recibidas) */
    /* llegada por cara (6.2) */
    int64_t arr_seen, arr_start, arr_last, move_next;
    int arr_sent, want_move;
    char move_mid[ID_LEN];
} B;

static EXT_RAM_BSS_ATTR body_ev mem[BODY_LOG_MAX], stage[BODY_LOG_MAX], sob[BODY_LOG_MAX];
static int nmem, nstage;
static EXT_RAM_BSS_ATTR char ackq[ACKQ][192];
static int ackq_n;

/* paquetes de salida: respaldo (1) o soltada (2), uno a la vez (el servidor arma uno por conexión) */
static EXT_RAM_BSS_ATTR uint8_t bk_buf[BODY_PKG_MAX], rel_buf[BODY_PKG_MAX], rx_buf[BODY_PKG_MAX];
static EXT_RAM_BSS_ATTR char bk_meta[META_MAX], rel_meta[META_MAX], b64tmp[BODY_CHUNK / 3 * 4 + 8];
static struct { int kind; const uint8_t *p; size_t n, sent; int seq; const char *meta; uint32_t bseq; } pk;
static struct { char mid[ID_LEN]; size_t n; } rel;   /* la soltada ya exportada, para mandarla igual otra vez (soltadas) */
/* paquete de entrada (deliver): la cabecera llega en "body" y los trozos en "body_pkg_in" */
static struct { int on, next, bad; char mid[ID_LEN], reason[24]; uint32_t n, seq; double at, now_srv; int64_t sent; size_t len; } dl;

static int64_t now_ms(void) { return hal_now_ms(); }
static int corriendo(int64_t t) { return B.activo && B.copy && t < B.lease_until; }

static const char *str(const cJSON *j, const char *k)
{
    const cJSON *v = cJSON_GetObjectItemCaseSensitive(j, k);
    return cJSON_IsString(v) ? v->valuestring : NULL;
}

static double num(const cJSON *j, const char *k, double dflt)
{
    const cJSON *v = cJSON_GetObjectItemCaseSensitive(j, k);
    return cJSON_IsNumber(v) ? v->valuedouble : dflt;
}

static void copy_str(char *dst, size_t cap, const char *s) { snprintf(dst, cap, "%s", s ? s : ""); }

/* ---- estado guardado (MEM_BODY, alma_mem.h): n, numeración de respaldos, protocolo y copia ---- */
static void save(void)
{
    if (!app_mem_writable()) {
        if (B.proto && !B.warned) hal_log("cuerpo: sin escritura de memoria; el estado del cuerpo queda solo en RAM");
        B.warned = 1;
        return;
    }
    alma_mem_body_v1 s = {B.n, B.seq_res, (uint8_t)B.proto, (uint8_t)B.copy};
    if (alma_mem_body_put(app_mem(), &s)) hal_log("cuerpo: no se pudo guardar el estado del cuerpo");
}

/* regla 2: el número de respaldo solo sube, también tras un reinicio (se reserva de a BODY_BSEQ_RESERVE) */
static void seq_to(uint32_t s)
{
    if (s > B.seq) B.seq = s;
    if (B.seq > B.seq_res) { B.seq_res = B.seq + BODY_BSEQ_RESERVE; save(); }
}

/* ---- registro de eventos ---- */
static int mem_find(const char *id)
{
    for (int i = 0; i < nmem; i++) if (strcmp(mem[i].id, id) == 0) return i;
    return -1;
}

static void mem_add(const body_ev *e)
{
    if (nmem == BODY_LOG_MAX) memmove(mem, mem + 1, (size_t)--nmem * sizeof *mem);   /* recortar: se va el más viejo */
    mem[nmem++] = *e;
}

static void mem_clear(void) { nmem = 0; }

static cJSON *ev_json(const body_ev *e)
{
    cJSON *o = cJSON_CreateObject();
    cJSON_AddStringToObject(o, "id", e->id);
    cJSON_AddStringToObject(o, "kind", e->kind);
    cJSON_AddRawToObject(o, "data", e->data[0] ? e->data : "{}");
    cJSON_AddNumberToObject(o, "at", e->at);
    if (e->from[0]) cJSON_AddStringToObject(o, "recuerdo_de", e->from);
    return o;
}

/* {"id","kind","data","at","recuerdo_de"} o solo el id (el reloj acepta las dos formas en su meta) → e. 0 = ok */
static int ev_parse(const cJSON *o, body_ev *e)
{
    memset(e, 0, sizeof *e);
    if (cJSON_IsString(o)) { copy_str(e->id, sizeof e->id, o->valuestring); copy_str(e->kind, sizeof e->kind, "recuerdo"); return 0; }
    const cJSON *id = cJSON_GetObjectItemCaseSensitive(o, "id");
    if (cJSON_IsString(id)) copy_str(e->id, sizeof e->id, id->valuestring);
    else if (cJSON_IsNumber(id)) snprintf(e->id, sizeof e->id, "%.0f", id->valuedouble);
    else return -1;
    copy_str(e->kind, sizeof e->kind, str(o, "kind") ? str(o, "kind") : "recuerdo");
    copy_str(e->from, sizeof e->from, str(o, "recuerdo_de"));
    e->at = num(o, "at", 0);
    const cJSON *d = cJSON_GetObjectItemCaseSensitive(o, "data");
    char *p = cJSON_IsObject(d) ? cJSON_PrintUnformatted(d) : NULL;
    copy_str(e->data, sizeof e->data, p && strlen(p) < sizeof e->data ? p : "{}");
    cJSON_free(p);
    return 0;
}

/* Lo que un evento del otro cuerpo (o de la PWA durante el tránsito) le hace al núcleo aquí (nucleo.aplicar). Los
   mismos tipos que el reloj (NucleoReloj.aplicar); hitos, fotos y trucos solo quedan como recuerdo */
static void apply(const body_ev *e)
{
    B.applying = 1;   /* lo que esto dispare (app_feed) no es un evento nuevo de este cuerpo */
    cJSON *d = cJSON_Parse(e->data);
    alma_ev ev = {EV_COUNT, -1, -1, -1, 0, 0, 0, 0};
    if (strcmp(e->kind, "comida") == 0) {
        int food = str(d, "food") ? alma_food_of(str(d, "food")) : -1;
        if (food >= 0) app_feed(food);
    } else if (strcmp(e->kind, "caricia") == 0) { ev.type = EV_TOUCH_PET; ev.value = 1500; }
    else if (strcmp(e->kind, "elogio") == 0) ev.type = EV_PRAISE;
    else if (strcmp(e->kind, "regaño") == 0) ev.type = EV_SCOLD;
    else if (strcmp(e->kind, "orden") == 0) {
        int act = str(d, "action_id") ? app_action_of(str(d, "action_id")) : -1;
        if (act >= 0) { ev.type = EV_REMOTE_COMMAND; ev.action_id = act; }
    }
    if (ev.type != EV_COUNT) app_post(&ev);
    hal_log("cuerpo: evento %s (%s)%s%s", e->id, e->kind, e->from[0] ? ", recuerdo de " : "", e->from);
    cJSON_Delete(d);
    B.applying = 0;
}

/* ---- mensajes de salida ---- */
static void queue_ack(const char *mid, int ok, const char *why)
{
    if (ackq_n == ACKQ) { memmove(ackq, ackq + 1, sizeof ackq[0] * (ACKQ - 1)); ackq_n--; }
    cJSON *j = cJSON_CreateObject();
    cJSON_AddStringToObject(j, "t", "body_ack");
    cJSON_AddStringToObject(j, "mid", mid);
    cJSON_AddBoolToObject(j, "ok", ok);
    cJSON_AddStringToObject(j, "why", why);
    if (cJSON_PrintPreallocated(j, ackq[ackq_n], sizeof ackq[0], 0)) ackq_n++;
    cJSON_Delete(j);
}

static void meta_json(char *out, size_t cap)
{
    cJSON *a = cJSON_CreateArray();
    for (int i = 0; i < nmem; i++) cJSON_AddItemToArray(a, ev_json(&mem[i]));
    if (!cJSON_PrintPreallocated(a, out, (int)cap, 0)) { hal_log("cuerpo: la lista de eventos no cabe; va vacía"); copy_str(out, cap, "[]"); }
    cJSON_Delete(a);
}

/* Respaldo numerado (respaldo, regla 2): el servidor ignora uno más viejo que el que ya tiene */
static void backup(int flush)
{
    B.next_backup = now_ms() + BODY_BACKUP_S * 1000LL;
    if (pk.kind == 2) return;   /* soltándola: ya no se respalda */
    long k = app_body_export(bk_buf, sizeof bk_buf, flush);
    if (k <= 0) { hal_log("cuerpo: no se pudo exportar la memoria para el respaldo"); return; }
    seq_to(B.seq + 1);
    meta_json(bk_meta, sizeof bk_meta);
    pk.kind = 1; pk.p = bk_buf; pk.n = (size_t)k; pk.sent = 0; pk.seq = 0; pk.meta = bk_meta; pk.bseq = B.seq;
    hal_log("cuerpo: respaldo %lu al servidor (%ld bytes, %d eventos)", (unsigned long)B.seq, k, nmem);
}

static void start_release(void)
{
    pk.kind = 2; pk.p = rel_buf; pk.n = rel.n; pk.sent = 0; pk.seq = 0; pk.meta = rel_meta; pk.bseq = 0;
}

static size_t b64(const uint8_t *in, size_t len, char *out)
{
    static const char T[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    size_t o = 0;
    for (size_t i = 0; i < len; i += 3) {
        uint32_t v = (uint32_t)in[i] << 16 | (i + 1 < len ? in[i + 1] << 8 : 0) | (i + 2 < len ? in[i + 2] : 0);
        out[o++] = T[v >> 18 & 63];
        out[o++] = T[v >> 12 & 63];
        out[o++] = i + 1 < len ? T[v >> 6 & 63] : '=';
        out[o++] = i + 2 < len ? T[v & 63] : '=';
    }
    out[o] = 0;
    return o;
}

/* base64 → rx_buf desde dl.len; −1 si no cabe o trae caracteres raros */
static int unb64(const char *s)
{
    uint32_t v = 0;
    int bits = 0;
    for (; *s; s++) {
        int c = *s;
        int d = c >= 'A' && c <= 'Z' ? c - 'A' : c >= 'a' && c <= 'z' ? c - 'a' + 26 : c >= '0' && c <= '9' ? c - '0' + 52
              : c == '+' ? 62 : c == '/' ? 63 : c == '=' ? -2 : -1;
        if (d == -2) break;
        if (d < 0) return -1;
        v = v << 6 | (uint32_t)d;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            if (dl.len >= sizeof rx_buf) return -1;
            rx_buf[dl.len++] = (uint8_t)(v >> bits);
        }
    }
    return 0;
}

/* {"t":"body_pkg","kind","seq","last","data"}; el primero lleva además la cabecera (n, bseq, meta o mid, meta) */
static long pkg_take(char *out, size_t cap)
{
    size_t k = pk.n - pk.sent < BODY_CHUNK ? pk.n - pk.sent : BODY_CHUNK;
    int last = pk.sent + k >= pk.n;
    b64(pk.p + pk.sent, k, b64tmp);
    cJSON *j = cJSON_CreateObject();
    cJSON_AddStringToObject(j, "t", "body_pkg");
    cJSON_AddStringToObject(j, "kind", pk.kind == 1 ? "backup" : "release");
    cJSON_AddNumberToObject(j, "seq", pk.seq);
    cJSON_AddNumberToObject(j, "last", last);
    if (pk.seq == 0) {
        if (pk.kind == 1) {
            cJSON_AddNumberToObject(j, "n", B.n);
            cJSON_AddNumberToObject(j, "bseq", pk.bseq);
        } else cJSON_AddStringToObject(j, "mid", rel.mid);
        cJSON_AddRawToObject(j, "meta", pk.meta);
    }
    cJSON_AddStringToObject(j, "data", b64tmp);
    long m = cJSON_PrintPreallocated(j, out, (int)cap, 0) ? (long)strlen(out) : 0;
    cJSON_Delete(j);
    if (!m) { hal_log("cuerpo: el trozo %d del paquete no cabe en %u bytes; se cancela", pk.seq, (unsigned)cap); pk.kind = 0; return 0; }
    pk.sent += k;
    pk.seq++;
    if (last) pk.kind = 0;
    return m;
}

/* El hello (hello): n, eventos por recuperar (5.6), acuses de la memoria actual (regla 4) y candados (5.3.7) */
static long hello(char *out, size_t cap)
{
    int nonce = B.next_nonce++;
    for (int pass = 0; pass < 2; pass++) {   /* si los eventos no caben, va sin ellos (y no cuenta como "los mandé") */
        cJSON *j = cJSON_CreateObject();
        cJSON_AddStringToObject(j, "t", "body_hello");
        cJSON_AddNumberToObject(j, "v", 1);
        cJSON_AddNumberToObject(j, "n", B.n);
        cJSON_AddNumberToObject(j, "nonce", nonce);
        cJSON *ev = cJSON_AddArrayToObject(j, "events"), *ak = cJSON_AddArrayToObject(j, "acked");
        int nev = 0;
        for (int i = 0; i < nmem; i++) {
            if (pass == 0 && mem[i].pending) { cJSON_AddItemToArray(ev, ev_json(&mem[i])); nev++; }
            if (mem[i].ack) cJSON_AddItemToArray(ak, cJSON_CreateString(mem[i].id));
        }
        cJSON *lk = cJSON_AddObjectToObject(j, "locks");
        cJSON_AddBoolToObject(lk, "noche", B.night);
        cJSON_AddBoolToObject(lk, "ota", 0);   /* TODO: no hay actualización por el aire en alma-f2; se escribe por USB */
        int ok = cJSON_PrintPreallocated(j, out, (int)cap, 0);
        cJSON_Delete(j);
        if (!ok) continue;
        B.hello[B.hello_i].nonce = nonce;
        B.hello[B.hello_i].sent = now_ms();
        B.hello[B.hello_i].ev_all = pass == 0 && nev > 0;
        B.hello_i = (B.hello_i + 1) % HELLO_RING;
        return (long)strlen(out);
    }
    hal_log("cuerpo: el hello no cabe en %u bytes", (unsigned)cap);
    return 0;
}

long body_take(char *out, size_t cap)
{
    if (!B.link) return 0;
    if (ackq_n) {
        long n = (long)strlen(ackq[0]);
        memcpy(out, ackq[0], (size_t)n + 1);
        memmove(ackq, ackq + 1, sizeof ackq[0] * (ACKQ - 1));
        ackq_n--;
        return n;
    }
    if (B.want_move) {
        B.want_move = 0;
        return snprintf(out, cap, "{\"t\":\"body_move\",\"mid\":\"%s\"}", B.move_mid);
    }
    int64_t t = now_ms();
    if (B.want_hello || t >= B.next_hello) {
        B.want_hello = 0;
        B.next_hello = t + BODY_HELLO_S * 1000LL;
        return hello(out, cap);
    }
    if (pk.kind) return pkg_take(out, cap);
    return 0;
}

/* ---- Alma se duerme sola si caduca el lease (vivir, 6.4) ---- */
static void vivir(int64_t t)
{
    if (B.proto && B.activo && t >= B.lease_until) {
        app_body_sleep("se durmió: no renovó el turno a tiempo (6.4)");
        B.activo = 0;
        save();
    }
}

/* ---- directivas del servidor (aplicar) ---- */
static void seguir(const cJSON *j, int64_t sent, int64_t t)
{
    uint32_t n = (uint32_t)num(j, "n", 0);
    double ls = num(j, "lease_s", BODY_LEASE_S);
    if (ls > BODY_LEASE_S || ls <= 0) ls = BODY_LEASE_S;   /* la invariante de 5.2 se cuida también aquí */
    if (n != B.n || !B.copy) return;
    if (!B.activo) {
        B.activo = 1;
        hal_log("cuerpo: el servidor confirma el turno (n %lu): Alma despierta aquí", (unsigned long)n);
    }
    int64_t until = sent + (int64_t)(ls * 1000.0);
    if (until > B.lease_until) B.lease_until = until;
    int nuevos = 0;
    const cJSON *e;
    cJSON_ArrayForEach(e, cJSON_GetObjectItemCaseSensitive(j, "events")) {
        body_ev x;
        if (ev_parse(e, &x)) continue;
        int i = mem_find(x.id);
        if (i < 0 && corriendo(t)) {
            x.since = B.seq;
            mem_add(&x);
            apply(&x);
            nuevos = 1;
            i = nmem - 1;
        }
        if (i >= 0) mem[i].ack = 1;
    }
    save();
    if (nuevos) backup(1);
}

static void soltar(const cJSON *j, int64_t t)
{
    const char *mid = str(j, "mid");
    if (!mid) return;
    if (rel.n && strcmp(rel.mid, mid) == 0) {   /* la misma mudanza: el mismo paquete otra vez */
        if (pk.kind != 2) start_release();
        return;
    }
    if (!B.copy) return;
    if (B.activo) app_body_sleep("se fue: el servidor la pide para el otro cuerpo (soltar)");
    B.activo = 0;
    B.turn_ms = t;
    long k = app_body_export(rel_buf, sizeof rel_buf, 1);   /* termina la conducta, guarda todo y exporta */
    if (k <= 0) { hal_log("cuerpo: no se pudo exportar la memoria para soltarla"); save(); return; }
    rel.n = (size_t)k;
    copy_str(rel.mid, sizeof rel.mid, mid);
    meta_json(rel_meta, sizeof rel_meta);
    save();
    start_release();
    hal_log("cuerpo: Alma se va (mudanza %s): manda su memoria (%ld bytes, %d eventos) y deja de correr el núcleo", mid, k, nmem);
}

static int received(const char *mid)
{
    for (int i = 0; i < RECV_KEEP; i++) if (strcmp(B.recv[i], mid) == 0) return 1;
    return 0;
}

static void recibir_head(const cJSON *j, int64_t sent)
{
    const char *mid = str(j, "mid");
    if (!mid) return;
    uint32_t n = (uint32_t)num(j, "n", 0);
    dl.on = 0;
    if (received(mid) && n == B.n) { queue_ack(mid, 1, ""); return; }   /* ya la tenía: solo el acuse */
    memset(&dl, 0, sizeof dl);
    dl.on = 1;
    copy_str(dl.mid, sizeof dl.mid, mid);
    copy_str(dl.reason, sizeof dl.reason, str(j, "reason"));
    dl.n = n;
    dl.seq = (uint32_t)num(j, "seq", 0);
    dl.at = num(j, "at", 0);
    dl.now_srv = num(j, "now", dl.at);
    dl.sent = sent;
    nstage = 0;
    const cJSON *e;
    cJSON_ArrayForEach(e, cJSON_GetObjectItemCaseSensitive(j, "meta")) {
        body_ev x;
        if (ev_parse(e, &x)) continue;
        if (nstage == BODY_LOG_MAX) memmove(stage, stage + 1, (size_t)--nstage * sizeof *stage);   /* se quedan los últimos */
        stage[nstage++] = x;
    }
    hal_log("cuerpo: llega Alma (mudanza %s, %s, n %lu): esperando su memoria", mid, dl.reason, (unsigned long)n);
}

static void recibir_fin(void)
{
    int64_t t = now_ms();
    vivir(t);
    if (dl.sent < B.turn_ms) { hal_log("cuerpo: paquete de una respuesta vieja (regla 1): no cuenta"); return; }
    /* regla 3: lo que la copia vieja vivió y la nueva no trae vuelve como recuerdo */
    int nsob = 0;
    for (int i = 0; B.copy && i < nmem; i++) {
        int in = 0;
        for (int k = 0; k < nstage && !in; k++) in = strcmp(stage[k].id, mem[i].id) == 0;
        if (!in) sob[nsob++] = mem[i];
    }
    double el = dl.now_srv - dl.at;
    if (el < 0) el = 0;
    if (el > BODY_CATCHUP_MAX_S) el = BODY_CATCHUP_MAX_S;
    if (app_body_import(rx_buf, dl.len, el)) {
        hal_log("cuerpo: el paquete de la mudanza %s no se pudo importar (%u bytes); se rechaza", dl.mid, (unsigned)dl.len);
        queue_ack(dl.mid, 0, "no se pudo importar el paquete");
        return;
    }
    B.n = dl.n;
    B.copy = 1;
    B.activo = 1;
    B.lease_until = dl.sent + BODY_LEASE_S * 1000LL;
    seq_to(dl.seq);   /* regla 2: sigue numerando desde el que dice el servidor */
    mem_clear();
    for (int k = 0; k < nstage; k++) {
        body_ev x = stage[k];
        x.meta = 1; x.pending = 0; x.ack = 0; x.since = B.seq;
        mem_add(&x);
    }
    for (int k = 0; k < nsob; k++) {
        body_ev x = sob[k];
        if (!x.from[0]) copy_str(x.from, sizeof x.from, "robot");
        x.meta = 0; x.pending = 0; x.ack = 0; x.since = B.seq;
        mem_add(&x);
        apply(&x);
    }
    copy_str(B.recv[B.recv_i], ID_LEN, dl.mid);
    B.recv_i = (B.recv_i + 1) % RECV_KEEP;
    B.turn_ms = t;
    save();
    queue_ack(dl.mid, 1, "");
    hal_log("cuerpo: Alma llegó (%s, n %lu, %.0f s de viaje); %d recuerdos de la copia vieja", dl.reason, (unsigned long)B.n, el, nsob);
    if (nsob) backup(1);
}

static void no_esta(const cJSON *j, int ev_all, int64_t t)
{
    uint32_t n = (uint32_t)num(j, "n", 0);
    if (B.activo) {
        app_body_sleep("no está: el turno es de otro cuerpo");
        B.turn_ms = t;
    }
    B.activo = 0;
    if (B.copy && n > B.n) {
        int np = 0;
        for (int i = 0; i < nmem; i++) {
            if (!ev_all) mem[i].pending = !mem[i].meta && mem[i].since >= B.acked_bseq;   /* lo no respaldado */
            np += mem[i].pending;
        }
        if (ev_all || np == 0) {
            B.copy = 0;   /* descarta su copia (6.4): el flash sigue ahí, pero ya no es Alma */
            mem_clear();
            hal_log("cuerpo: Alma vive en otro cuerpo (n %lu > %lu): se descarta la copia local", (unsigned long)n, (unsigned long)B.n);
        } else {
            B.want_hello = 1;
            hal_log("cuerpo: Alma vive en otro cuerpo; %d eventos por recuperar van en el siguiente hello (5.6)", np);
        }
    }
    save();
}

static void directive(const cJSON *j)
{
    int nonce = (int)num(j, "nonce", -1), h = -1;
    for (int i = 0; i < HELLO_RING; i++) if (B.hello[i].nonce == nonce) h = i;
    if (h < 0 || nonce <= 0) { hal_log("cuerpo: respuesta a un hello desconocido (nonce %d): no cuenta", nonce); return; }
    int64_t sent = B.hello[h].sent, t = now_ms();
    int ev_all = B.hello[h].ev_all;
    if (!B.proto) {
        /* primera respuesta del protocolo: venía corriendo como siempre; desde aquí manda el servidor */
        B.proto = 1;
        B.activo = B.copy;
        B.lease_until = sent + BODY_LEASE_S * 1000LL;
        if (app_mem_writable()) { B.tag = B.seq_res + 1; B.seq_res += BODY_BSEQ_RESERVE; }
        save();
        hal_log("cuerpo: el servidor habla el protocolo de mudanza (n %lu): desde ahora Alma corre aquí solo con su turno",
                (unsigned long)B.n);
    }
    vivir(t);
    if (sent < B.turn_ms) { hal_log("cuerpo: respuesta a un hello de antes del último cambio de turno (regla 1): no cuenta"); return; }
    const char *d = str(j, "d");
    if (!d) return;
    if (strcmp(d, "keep") == 0) seguir(j, sent, t);
    else if (strcmp(d, "release") == 0) soltar(j, t);
    else if (strcmp(d, "deliver") == 0) recibir_head(j, sent);
    else if (strcmp(d, "absent") == 0) no_esta(j, ev_all, t);
    else hal_log("cuerpo: directiva '%s' desconocida", d);
}

static void pkg_in(const cJSON *j)
{
    const char *mid = str(j, "mid");
    if (!dl.on || !mid || strcmp(mid, dl.mid) != 0) return;
    int s = (int)num(j, "seq", -1);
    const char *data = str(j, "data");
    if (s != dl.next || !data || unb64(data)) dl.bad = 1;
    dl.next = s + 1;
    if (!(int)num(j, "last", 0)) return;
    dl.on = 0;
    /* incompleto (p. ej. se cortó el enlace): sin acuse; el servidor lo repite en el siguiente hello */
    if (dl.bad) { hal_log("cuerpo: el paquete de la mudanza %s llegó incompleto; se espera otra vez", dl.mid); return; }
    recibir_fin();
}

static void pkg_result(const cJSON *j)
{
    const char *k = str(j, "kind");
    int ok = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(j, "ok"));
    if (k && strcmp(k, "backup") == 0) {
        uint32_t s = (uint32_t)num(j, "bseq", 0);
        if (ok && s > B.acked_bseq) B.acked_bseq = s;   /* resultadoRespaldo: lo que llevaba ya está a salvo */
        if (!ok) hal_log("cuerpo: el servidor no tomó el respaldo %lu", (unsigned long)s);
    } else if (k && strcmp(k, "release") == 0) hal_log("cuerpo: soltada %s: %s", str(j, "mid") ? str(j, "mid") : "?", ok ? "recibida" : "rechazada");
    else hal_log("cuerpo: paquete rechazado por el servidor (%s)", str(j, "why") ? str(j, "why") : "?");
}

void body_msg(const char *json)
{
    cJSON *j = cJSON_Parse(json);
    const char *t = str(j, "t");
    if (!t) { cJSON_Delete(j); return; }
    if (strcmp(t, "body") == 0) directive(j);
    else if (strcmp(t, "body_pkg_in") == 0) pkg_in(j);
    else if (strcmp(t, "body_pkg_result") == 0) pkg_result(j);
    else if (strcmp(t, "body_poke") == 0) B.want_hello = 1;
    else if (strcmp(t, "body_move_result") == 0)
        hal_log("cuerpo: llegada por cara %s: %s (%s)", str(j, "mid") ? str(j, "mid") : "?",
                cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(j, "ok")) ? "aceptada" : "no", str(j, "why") ? str(j, "why") : "");
    else hal_log("cuerpo: mensaje '%s' desconocido", t);
    cJSON_Delete(j);
}

/* ---- API ---- */
void body_init(void)
{
    memset(&B, 0, sizeof B);
    memset(&pk, 0, sizeof pk);
    memset(&rel, 0, sizeof rel);
    memset(&dl, 0, sizeof dl);
    nmem = nstage = ackq_n = 0;
    B.n = 1;      /* el servidor empieza en n = 1 con Alma en el robot (body.fresh) */
    B.copy = 1;
    B.turn_ms = T_NEVER;
    B.lease_until = T_NEVER;
    B.next_nonce = 1;
    B.arr_seen = B.arr_start = -1;
    alma_mem_body_v1 s;
    if (alma_mem_body_get(app_mem(), &s) == 0) {
        B.n = s.n ? s.n : 1;
        B.seq = B.seq_res = s.bseq;
        B.proto = s.proto;
        B.copy = s.copy;
    }
    /* ids únicos entre arranques (eventos y pedidos de llegada): la reserva de respaldos solo sube y cada arranque con
       el protocolo toma un número nuevo (una escritura por arranque); sin escritura, la hora */
    B.tag = (uint32_t)app_now_s();
    if (B.proto && app_mem_writable()) {
        B.tag = B.seq_res + 1;
        B.seq_res += BODY_BSEQ_RESERVE;
        save();
    }
    if (B.proto)
        hal_log("cuerpo: protocolo de mudanza activo (n %lu, %s): arranca sin Alma hasta que el servidor conteste",
                (unsigned long)B.n, B.copy ? "con su copia" : "sin copia");
}

void body_set_link(int up)
{
    B.link = up;
    pk.sent = 0;     /* el servidor arma los paquetes por conexión: uno a medias empieza de nuevo */
    pk.seq = 0;
    dl.on = 0;
    if (up) B.want_hello = 1;
}

void body_step(void)
{
    int64_t t = now_ms();
    vivir(t);
    if (B.night && t - B.night_since > BODY_NIGHT_LOCK_MAX_S * 1000LL) { B.night = 0; hal_log("cuerpo: candado de la noche suelto (sin respuesta de Haiku)"); }
    if (B.proto && corriendo(t) && t >= B.next_backup) backup(0);   /* la memoria ya se guardó en el calendario de 06 */
    /* llegada por la cara del dueño (6.2): solo sin Alma, con enlace, y con detecciones de verdad del K210 */
    if (!B.proto || corriendo(t) || !B.link) { B.arr_start = -1; return; }
    int who;
    int64_t seen = perception_last_who(&who);
    if (seen < 0 || seen == B.arr_seen) return;
    B.arr_seen = seen;
    if (who != BODY_OWNER_ID) return;
    if (B.arr_start < 0 || seen - B.arr_last > BODY_ARRIVAL_GAP_MS) { B.arr_start = seen; B.arr_sent = 0; }
    B.arr_last = seen;
    if (B.arr_sent || seen - B.arr_start < BODY_ARRIVAL_SUSTAIN_MS || t < B.move_next) return;
    B.arr_sent = 1;
    B.move_next = t + BODY_MOVE_RETRY_MS;
    snprintf(B.move_mid, sizeof B.move_mid, "cara-robot-%lu-%lu", (unsigned long)B.tag, (unsigned long)++B.move_k);
    B.want_move = 1;
    hal_log("cuerpo: el dueño frente a la cámara %lld s: pide que Alma regrese (%s)", (long long)((seen - B.arr_start) / 1000), B.move_mid);
}

int body_runs(void) { return !B.proto || corriendo(now_ms()); }
int body_watching(void) { return B.arr_start >= 0 && now_ms() - B.arr_last <= BODY_ARRIVAL_GAP_MS; }
int body_protocol(void) { return B.proto; }

void body_event(const char *kind, const char *data_json)
{
    if (B.applying || !B.proto || !corriendo(now_ms())) return;
    body_ev e;
    memset(&e, 0, sizeof e);
    snprintf(e.id, sizeof e.id, "robot-%lu-%lu", (unsigned long)B.tag, (unsigned long)++B.ev_k);
    copy_str(e.kind, sizeof e.kind, kind);
    copy_str(e.data, sizeof e.data, data_json && strlen(data_json) < sizeof e.data ? data_json : "{}");
    e.at = app_now_s();
    e.since = B.seq;
    mem_add(&e);
    save();
    backup(1);
}

void body_night(int on)
{
    if (on == B.night) return;
    B.night = on;
    B.night_since = now_ms();
    if (B.proto) B.want_hello = 1;   /* que el servidor sepa del candado ya */
}
