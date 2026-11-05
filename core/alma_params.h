/* alma_params.h — constantes del núcleo de personalidad. Todas son CALIBRAR (04).
 *
 * Origen en cada comentario:
 *   04 = alma-spec/04-motor-de-personalidad.md, 05 = catálogo, 01 = arquitectura.
 *   DERIVADO = 04 no da número; valor aprobado por el dueño el 2026-10-27.
 * El simulador (sim/) compila contra este mismo archivo: no hay copia que mantener.
 */
#ifndef ALMA_PARAMS_H
#define ALMA_PARAMS_H

/* ---- Rasgos (04, "Rasgos" y "Plasticidad") ---- */
#define TRAIT_PLASTIC_AGE_DAYS        50       /* 04: horizonte de desarrollo de Moflin */
#define TRAIT_PLASTICITY_YOUNG        1.0f     /* 04 */
#define TRAIT_PLASTICITY_ADULT        0.1f     /* 04: r = 0.30 cachorros vs 0.51 adultos (Fratkin 2013) */
#define TRAIT_MAX_DELTA_NIGHT         0.02f    /* 04: max_delta_por_noche */
#define TRAIT_IMPULSIVITY_PLASTICITY  0.1f     /* 04: "trait_impulsivity usa plasticity * 0.1" */
#define TRAIT_ENERGY_DECLINE_DAY      60       /* 04: Turcsán et al. 2020 */
#define TRAIT_ENERGY_DECLINE_PER_DAY  0.0005f  /* 04 */
#define TRAIT_ENERGY_DECLINE_MAX      0.1f     /* 04: hasta valor_al_nacer − 0.1 */
/* rasgo = trait_base (semilla, fijo) + trait_learned (experiencia), recortado a [0, 1].
 * Decisión del dueño (2026-10-27): con el dueño brusco los rasgos llegaban a 0 o 1 hacia el día 20-30
 * y las semillas convergían (A2.3: 14/45 pares). El tope se aplica sobre trait_learned. */
#define TRAIT_LEARNED_MAX             0.25f
#define TRAIT_NUDGE_MAX               0.01f    /* 07: cada trait_nudge en [-0.01, 0.01] */
/* d_soc = clip((pets + praises + play_done − 3·scolds − 5·shakes) / 20) (04) */
#define NIGHT_DSOC_SCOLD_W            3.0f
#define NIGHT_DSOC_SHAKE_W            5.0f
#define NIGHT_DSOC_DIV                20.0f
/* d_bold = clip((novel_ok + explore_ok − 3·scares) / 10) (04) */
#define NIGHT_DBOLD_SCARE_W           3.0f
#define NIGHT_DBOLD_DIV               10.0f
/* d_play = clip((play_done − play_ignored/2) / 5) (04) */
#define NIGHT_DPLAY_IGNORED_DIV       2.0f
#define NIGHT_DPLAY_DIV               5.0f
/* d_play − 3·scolds − 5·shakes: el maltrato resta juego (decisión del dueño, 2026-10-27; mismos pesos que d_soc) */
#define NIGHT_DPLAY_SCOLD_W           3.0f
#define NIGHT_DPLAY_SHAKE_W           5.0f

/* ---- Emociones (04, "Emociones") ---- */
#define FEAR_HALF_LIFE_S              20.0f    /* 04: media vida 20 s */
#define FEAR_ZERO_S                   60.0f    /* 04: "se considera 0 a los 60 s"; DERIVADO: desde el último estímulo */
/* emo_joy: curva por tramos desde el último estímulo (04, curva por defecto de Vector) */
#define JOY_CURVE_T                   {0.0f, 10.0f, 30.0f, 75.0f, 150.0f}
#define JOY_CURVE_V                   {1.0f, 1.0f, 0.9f, 0.6f, 0.0f}
#define JOY_CURVE_N                   5
#define FRUST_LINEAR_S                70.0f    /* 04: lineal a 0 en 70 s */
#define REPEAT_NO_EFFECT_S            0.5f     /* 04: repetición en < 0.5 s no tiene efecto */
#define REPEAT_RECOVER_S              10.0f    /* 04: recupera 100% a los 10 s */
#define FEAR_GAIN_BASE                1.5f     /* 04: deltas de miedo × (1.5 − boldness) */
#define JOY_SOCIAL_GAIN_BASE          0.7f     /* 04: × (0.7 + 0.6·sociability) */
#define JOY_SOCIAL_GAIN_SOC           0.6f
#define SAFE_BASE_BOLDNESS            0.15f    /* 04: base segura, boldness efectivo +0.15 */

/* Efecto de cada evento (04, tabla "Efecto de cada evento").
 * X(evento, fear, joy, frust, stim, need_social, w_apego, apego_absoluto, joy_social)
 * joy_social = 1: se aplica la ganancia de sociabilidad. DERIVADO: también a EV_SCOLD. */
#define ALMA_EVENT_EFFECTS(X) \
    X(EV_TOUCH_PET,     -0.2f,  0.4f, -0.2f, 0.10f, -0.20f, 1.0f,  0.00f, 1) \
    X(EV_TOUCH_TAP,      0.0f,  0.1f,  0.0f, 0.10f, -0.05f, 0.2f,  0.00f, 1) \
    X(EV_FACE_UNKNOWN,   0.3f,  0.0f,  0.0f, 0.30f,  0.00f, 0.0f,  0.00f, 0) \
    X(EV_PRAISE,         0.0f, 0.35f, -0.1f, 0.10f, -0.10f, 0.6f,  0.00f, 1) \
    X(EV_SCOLD,          0.1f, -0.2f,  0.2f, 0.10f,  0.00f, 0.0f,  0.00f, 1) /* antes −0.03 de apego; decisión del dueño 2026-10-27 */ \
    X(EV_VOICE_FAILED,   0.0f,  0.0f, 0.15f, 0.00f,  0.00f, 0.0f,  0.00f, 0) \
    X(EV_PICKED_UP,      0.3f,  0.0f,  0.0f, 0.20f,  0.00f, 0.0f,  0.00f, 0) \
    X(EV_SHAKEN,         0.6f, -0.3f,  0.3f, 0.20f,  0.00f, 0.0f, -0.08f, 0) \
    X(EV_TIPPED_OVER,    0.5f,  0.0f,  0.3f, 0.10f,  0.00f, 0.0f,  0.00f, 0) \
    X(EV_CLIFF,          0.4f,  0.0f,  0.0f, 0.10f,  0.00f, 0.0f,  0.00f, 0) \
    X(EV_LOUD_SOUND,     0.5f,  0.0f,  0.0f, 0.20f,  0.00f, 0.0f,  0.00f, 0) \
    X(EV_OBSTACLE,       0.0f,  0.0f,  0.0f, 0.05f,  0.00f, 0.0f,  0.00f, 0)

/* Casos especiales de la misma tabla (04) */
#define ARRIVAL_JOY_PER_A             0.3f     /* EV_FACE_SEEN tras ≥ 10 min: joy +0.3·A */
#define ARRIVAL_STIM                  0.1f
#define ARRIVAL_SOCIAL               -0.15f
#define ARRIVAL_W                     0.2f
#define ARRIVAL_ABSENCE_S             600.0f   /* 04: llegada tras ≥ 10 min de ausencia */
#define FACING_STIM_PER_MIN           0.02f    /* persona conocida de frente, por minuto */
#define FACING_SOCIAL_PER_MIN        -0.05f
#define FACING_W_PER_MIN              0.5f
#define VOICE_CMD_STIM                0.2f
#define VOICE_CMD_SOCIAL             -0.05f
#define VOICE_CMD_W_OBEY              0.3f
#define INTERRUPTED_FRUST             0.15f    /* × (1 − 0.5·impulsivity) */
#define INTERRUPTED_IMP_W             0.5f
#define PLAY_DONE_JOY                 0.3f
#define PLAY_DONE_STIM                0.2f
#define PLAY_DONE_SOCIAL             -0.1f
#define PLAY_DONE_W                   1.0f

/* ---- Necesidades (04, "Necesidades") ---- */
#define NEED_SOCIAL_INIT              0.3f
#define NEED_SOCIAL_RISE_PER_H        0.1f     /* × (0.5 + sociability) sin compañía */
#define NEED_SOCIAL_SOC_BASE          0.5f
#define NEED_SOCIAL_CEIL              0.9f     /* techo: la soledad nunca escala a culpa */
#define STIM_INIT                     0.5f
#define STIM_LOW                      0.2f     /* pendientes de Stimulated en Vector, por minuto */
#define STIM_HIGH                     0.8f
#define STIM_DECAY_LOW_PER_MIN        0.6f
#define STIM_DECAY_MID_PER_MIN        0.12f
#define STIM_DECAY_HIGH_PER_MIN       0.4f
#define NEED_REST_AWAKE_H             16.0f    /* awake_h / 16 */
#define BOREDOM_NEED_STIM             0.7f
#define BOREDOM_HOLD_S                600.0f
#define BOREDOM_DISTINCT              3
#define BOREDOM_WINDOW_S              1800.0f
#define BOREDOM_RISE_PER_MIN          0.1f
#define BUDGET_BASE_S                 3600.0f  /* budget_s = 3600 + 3600·energy */
#define BUDGET_ENERGY_S               3600.0f
#define BUDGET_MARGIN                 1.3f     /* 04: peor caso de la variación (pausa ×1.3) */

/* ---- Afecto y ánimo (04) ---- */
#define VAL_FEAR_W                    0.8f
#define VAL_FRUST_W                   0.6f
#define VAL_BOREDOM_W                 0.3f
#define VAL_SOCIAL_W                  0.2f
#define AROUSAL_JOY_W                 0.8f
#define AROUSAL_FRUST_W               0.7f
#define AROUSAL_STIM_W                0.6f
#define AROUSAL_REST_W                0.5f
#define MOOD_TAU_S                    10800.0f /* 3 h; rango 2-4 h */
#define NIGHT_MOOD_FACTOR             0.5f
/* Tamagotchi (dueño, 2026-10-30: hambre, comida real desde la app, ella decide; golosinas de más empachan) */
#define HUNGER_RISE_PER_H             0.20f    /* ~3–4 comidas al día; × (0.8 + 0.4·energy) */
#define HUNGER_SLEEP_F                0.2f     /* dormida le da menos hambre (dueño, 2026-11-01: nadie le da de comer de noche) */
#define HUNGRY_AT                     0.70f    /* "tiene hambre": pide comida y avisa al celular */
#define STARVING_AT                   0.95f
#define FULL_AT                       0.12f    /* llena: solo acepta golosinas (y no siempre) */
#define VAL_HUNGER_W                  0.5f     /* valencia − w·max(0, hunger − 0.5) */
#define VAL_SICK                      0.2f
#define TREATS_BEFORE_SICK            3        /* más golosinas en el día: empacho con probabilidad SICK_P */
#define SICK_P                        0.5f
#define SICK_CURE_S                   (24 * 3600.0)
#define FAINT_TAU_S                   (2 * 86400.0)   /* secuela del desmayo: e^(−t/2 días), 60 % al día, 8 % a los 5 */
#define FAINT_REST                    0.6f     /* débil: la necesidad de descanso no baja de 0.6·secuela */
#define FAINT_SAD                     0.5f     /* triste: valencia − 0.5·secuela */
#define FAINT_MOOD                   -0.6f     /* el ánimo al desmayarse */
#define NEAR_SEEN_MM                  350      /* algo aparece enfrente: más cerca que esto (la red decide si le interesa) */
#define NEAR_GONE_MM                  450      /* y se va cuando pasa de esto (histéresis) */
#define NEAR_FAR_MM                   400.0f   /* entrada de la red: 0 a esta distancia o más, 1 pegado */
#define GAME_REACT_MIN_INTEREST       0.25f    /* juegos de la app: con menos interés (habituada) no reacciona */
#define GAME_JOY_WIN                  0.35f
#define GAME_FRUST_LOSE               0.25f
#define FOOD_LIKE_LEARN               0.03f    /* comer con hambre algo que no le gusta: le gusta un poco más */
#define WB_MEAL_PTS                   2.0f     /* bienestar: por comida aceptada con hambre (> 0.4) */
#define WB_MEAL_CAP                   6.0f
#define WB_STARVE_PTS_PER_30MIN       1.0f
#define WB_STARVE_CAP                 12.0f
#define WB_REMOTE_MAX                 30.0f    /* juegos desde la app: 30·(1 − e^(−min/120)), 2 h ≈ +19 (dueño) */
#define WB_REMOTE_TAU_MIN             120.0f

#ifndef FORGET_DAYS
#define FORGET_DAYS                   28       /* 06 (dueño, 2026-10-30): sin verse 4 semanas, se olvida */
#endif
#define ALMA_OWNER_ID                 0        /* la cara del dueño (K210 id 0): nunca se olvida */
#define SM_SCARED_FEAR                0.5f
#define SM_SLEEPY_REST                0.7f
#define SM_GRUMPY_FRUST               0.4f
#define SM_GRUMPY_MOOD               -0.4f
#define SM_BORED_BOREDOM              0.5f
#define SM_PLAYFUL_JOY                0.4f
#define SM_PLAYFUL_AROUSAL            0.5f
#define SM_PLAYFUL_TRAIT              0.3f
#define SM_HAPPY_VALENCE              0.3f
/* Presencia (dueño, 2026-10-30): feliz con él delante, triste sin él. DERIVADO: valores elegidos para que con A = 0
 * ya pase de SM_HAPPY_VALENCE y la tristeza sola no llegue a SM_GRUMPY_MOOD */
#define PRESENCE_VAL_W                0.5f
#define PRESENCE_A_BASE               0.7f     /* valencia +0.35 con A = 0, +0.5 con A = 1 */
#define ABSENCE_VAL_MAX               0.35f
#define ABSENCE_GRACE_S               120.0f   /* los primeros 2 min sin verlo no cuentan */
#define ABSENCE_RAMP_S                1200.0f  /* tristeza completa a los 22 min */
/* Bienestar (dueño, 2026-10-30): puntaje de largo plazo de ±1023 (10 bits por lado), 0 al nacer. Cada noche se
 * acerca WB_DRIFT a 0 y suma los puntos del día (cuenta local, ±30; Haiku los ajusta ±10), ponderados (dueño): alejarse
 * de 0 cuesta más cuanto más lejos (WB_OUT_*), y volver hacia 0 pesa más cuanto más lejos (WB_IN_GAIN). DERIVADO: pesos */
#define WB_MAX                        1023.0f
#define WB_DRIFT                      0.006f   /* mantenerse en el tope pide ~25 puntos al día */
#define WB_OUT_KNEE                   500.0f   /* hasta aquí los puntos hacia el extremo cuentan completos */
#define WB_OUT_MIN                    0.25f    /* en ±1023 cuentan el 25 % */
#define WB_IN_GAIN                    3.0f     /* hacia 0: × (1 + 3·(|w|)²), ×4 en el tope */
#define WB_DAY_MAX                    30
#define WB_CLOUD_ADJ_MAX              10
#define WB_PLAY_PTS                   2.0f     /* por juego contigo (play_done), hasta WB_PLAY_CAP */
#define WB_PLAY_CAP                   20.0f
#define WB_PET_CAP                    8.0f     /* caricias + elogios, 1 cada una */
#define WB_SEEN_CAP                   5.0f     /* 1 por hora en que te vio */
#define WB_EXPLORE_PTS                0.5f     /* por exploración sin borde, hasta WB_EXPLORE_CAP */
#define WB_EXPLORE_CAP                3.0f
#define WB_SCARE_PTS                  2.0f     /* sustos (borde, volcado, sacudida…), hasta WB_SCARE_CAP */
#define WB_SCARE_CAP                  10.0f
#define WB_LIFT_PTS                   1.0f
#define WB_LIFT_CAP                   5.0f
#define WB_SHAKE_PTS                  3.0f
#define WB_SHAKE_CAP                  9.0f
#define WB_SCOLD_PTS                  3.0f
#define WB_SCOLD_CAP                  9.0f
#define WB_ABSENT_PTS                 5.0f     /* un día sin verte; −2 más por cada día seguido, hasta WB_ABSENT_CAP */
#define WB_ABSENT_STEP                2.0f
#define WB_ABSENT_CAP                 15.0f
#define WB_VAL_W                      0.3f     /* valencia + 0.3·w, w = wellbeing / WB_MAX */
#define WB_PAUSE_W_SAD                0.4f     /* w < 0: pausas × (1 − 0.4·w), deprimido 40 % más largas */
#define WB_PAUSE_W_HAPPY              0.1f     /* w > 0: × (1 − 0.1·w); más no: con 0.4 el atento repetía ternas (A2.2) */
#define WB_PLAY_W                     0.6f     /* conductas de juego × (1 + 0.6·w) */
#define WB_RUN_MIN                   -0.3f     /* por debajo no corre; arriba, probabilidad energy·(1 + 0.5·w) */
#define WB_DEPRESSED                 -0.6f     /* debajo, rechaza órdenes de juego con probabilidad hasta WB_REFUSE_MAX */
#define WB_REFUSE_MAX                 0.5f
/* Correr (dueño, 2026-10-30: "puede correr si quiere"). DERIVADO: juego o exploración con marcha, juguetón o contento,
 * arousal alto y sin bordes en 30 min ("explorar con cuidado"); probabilidad = energy */
#define RUN_TEMPO                     0.6f     /* periodo del paso × 0.6; el firmware no baja de MOTION_RUN_MIN_MS */
#define RUN_AROUSAL                   0.5f
#define RUN_NO_CLIFF_S                1800.0f

/* ---- Selección (04, "Selección de conducta") ---- */
#define SEL_TOP_K                     4
#define SEL_T_BASE                    0.15f
#define SEL_T_IMPULSIVITY             0.35f
#define SEL_PREF_GAIN                 0.5f
#define SEL_PREF_IGNORE_P             0.10f    /* 04: 10% de las decisiones ignoran pref */
#define SEL_MIN_SCORE                 0.05f    /* regla 6 */
#define SEL_HYSTERESIS                1.5f     /* regla 2 */
#define HYST_MIN_RUN_S                5.0f     /* regla 2 no corta una conducta antes de 5 s (robot, 2026-10-30: un baile recién elegido lo cortó un parpadeo a los 0.1 s) */
#define NO_BOTHER_FAILS               2        /* regla 3 */
#define NO_BOTHER_RESPONSE_S          60.0f
#define NO_BOTHER_SUPPRESS_S          1200.0f
#define NO_BOTHER_STIM_DROP           0.2f     /* DERIVADO: "baja su activación" */
#define RELAXED_BATTERY               30.0f    /* regla 4 */
#define SAVE_BATTERY_PCT              50.0f    /* dueño, 2026-11-02: con menos de esto camina un poco menos ("que baje poco") */
#define SAVE_LOCO_F                   0.8f
#define RELAXED_FEAR                  0.2f
#define RELAXED_NO_FALL_S             600.0f
#define CLIFF_RECENT_S                600.0f   /* DERIVADO: "EV_CLIFF reciente" de 05 = misma ventana de la regla 4 */
/* Regla 5. Calibrado en sim/ el 2026-10-27 (antes 2-20 s y [2, 20 − 10·energy]): con 2-20 s había ~2000
 * decisiones al día, la regla 6 llenaba la mitad y A2.1/A2.2 fallaban todos los días. Aprobado por el dueño. */
#define PAUSE_MIN_S                   60.0f
#define PAUSE_MAX_S                   300.0f
#define PAUSE_ENERGY_S                120.0f   /* pausa uniforme en [60, 300 − 120·energy] */
#define MUSIC_DANCE_GAP_S             300.0f   /* dueño, 2026-10-30: con música baila y no otra vez en 5 min (aparte del cooldown de 20 min de bhv_dance) */
#define MUSIC_ENGAGED_S               120.0f   /* dueño: con caricia, toque o elogio hace menos de 2 min, la música no la hace bailar */
#define GOODBYE_MIN_A                 0.05f    /* apego mínimo para despedirse (DERIVADO) */
#define GOODBYE_GONE_S                115.0f   /* dueño, 2026-11-05: se despide solo si ya no lo ve en ~2 min (EV_FACE_LOST llega a los 5 s) */
#define GOODBYE_MIN_VISIT_S           300.0f   /* ... de una visita de al menos 5 min en la que ya lo había saludado */
#define WINDOW_BOOST                  3.0f     /* respuesta a una caricia o elogio en su ventana × 3 (2026-10-30: con 40 conductas casi nunca ganaba) */
#define PRESENCE_PAUSE_F              0.35f    /* dueño, 2026-10-30: con alguien conocido delante, pausas × 0.35 ("que haga cosas, que llame mi atención") */
#define RESPONSE_WINDOW_S             5.0f     /* 05 "Cómo se disparan" */
#define SPEED_MIN                     0.85f    /* 04: velocidad ×[0.85, 1.15] */
#define SPEED_MAX                     1.15f
#define GAIT_MODE_AVAILABLE           1        /* 05 regla †. Dueño, 2026-10-30: camina sola fuera de la base (marcha medida en el robot) */
#ifndef ALMA_DEV_MOTION_ON_USB
#define ALMA_DEV_MOTION_ON_USB        0        /* 09 R14: 1 solo en desarrollo; deja mover servos mientras carga */
#endif
#define HYST_CHECK_S                  5.0f     /* DERIVADO (implementación): la regla 2 se revisa cada 5 s y tras cada evento */

/* ---- Apego (04, "Apego por persona") ---- */
/* A += K_ATTACH·(1 − A)^(1 + ATTACH_GAMMA)·w·(0.5 + sociability). Recalibrado el 2026-10-27 (antes 0.023 y
 * exponente 1): con el dueño atento A pasaba de 0.9 el primer día. Ahora 30 unidades de w (A4.3: 3 × 10 min)
 * dan A ≈ 0.42 con sociability 0.5, y llegar a 0.9 toma semanas (decisión del dueño: 4 a 6 con el atento). */
#define K_ATTACH                      0.046f
#define ATTACH_GAMMA                  3.0f
#define ATTACH_SOC_BASE               0.5f
#define ATTACH_FALL_DROP              0.1f     /* caída provocada */
#define ATTACH_FLOOR_TRIGGER          0.5f
#define ATTACH_FLOOR                  0.3f
#define ATTACH_ABSENCE_DECAY          0.99f    /* por día sin ver a la persona */
#define WARY_BASE_H                   2.0f     /* wary = 2 + 4·(1 − boldness) h */
#define WARY_BOLD_H                   4.0f
#define FALL_PROVOKED_S               10.0f    /* 04 "Contadores": caída provocada */
#define GREET_SAT_T0                  600.0f   /* sat(ausencia) */
#define GREET_SAT_T1                  1800.0f
#define GREET_SAT_T2                  7200.0f
#define GREET_SAT_V0                  0.1f
#define GREET_SAT_V1                  0.3f
#define GREET_A_BASE                  0.4f
#define GREET_A_W                     0.6f
#define GREET_SOC_BASE                0.5f
#define GREET_SOC_W                   0.5f
#define PREF_UP                       0.1f
#define PREF_DOWN                     0.03f
#define PREF_RESPONSE_S               10.0f
#define VISIT_END_S                   600.0f   /* DERIVADO: una visita termina tras 10 min de ausencia */
#define FACE_LOST_S                   5.0f     /* 01: sin detección por 5 s */
#define FACING_X_CENTER               160.0f   /* DERIVADO: |x − 160| < 60 y w ≥ 40 */
#define FACING_X_TOL                  60.0f
#define FACING_MIN_W                  40.0f

/* ---- Habituación (04) ---- */
#define INTEREST_EXEC_FACTOR          0.6f
#define INTEREST_HALF_LIFE_S          14400.0f /* 4 h; rango 3-6 h */
#define INTEREST_NIGHT_RESTORE        0.5f

/* ---- Órdenes (04, "Órdenes de voz y obediencia") ---- */
#define OBEY_BASE                     0.35f
#define OBEY_A                        0.40f
#define OBEY_MOOD                     0.15f
#define OBEY_TRAINED                  0.20f
#define OBEY_REST                     0.30f
#define OBEY_FEAR                     0.40f
#define OBEY_FRUST                    0.20f
#define OBEY_MIN                      0.05f
#define OBEY_MAX                      0.98f
#define OBEY_WARY_FACTOR              0.5f
#define TRAIN_UP                      0.1f
#define TRAIN_RESPONSE_S              10.0f

/* ---- Ritmo diario y estados (04, "Ritmo diario") ---- */
#define PRESENCE_ALPHA                0.1f
#define PRESENCE_INIT                 0.3f
#define PRESENCE_AWAKE                0.3f
/* dueño, 2026-11-01: duerme de 20:00 a 8:00, fijo (antes, el bloque de 7 h con menos presencia, aprendido) */
#define NIGHT_WINDOW_H                12
#define NIGHT_WINDOW_DEFAULT_START    20
#define WAKE_FACE_A                   0.5f
#define REST_ENTER                    0.7f     /* 04: need_rest > 0.7 → ST_RESTING */
#define REST_EXIT                     0.5f     /* 04: vuelve con < 0.5 */
#define INACTIVE_NO_FACE_S            600.0f   /* 04: casa inactiva */
#define STIMULUS_STICKY_S             180.0f   /* 04: 3 min tras un estímulo */
#define SHAKE_END_S                   3.0f     /* DERIVADO: el reflejo de sacudida termina tras 3 s sin sacudidas */
#define ASK_HELP_EVERY_S              8.0f     /* volcado: repite bhv_ask_help cada 8 s hasta que la levanten (dueño, 2026-11-02) */
#define PUT_DOWN_STABLE_S             1.0f     /* 05: EV_PUT_DOWN y 1 s estable */
/* 04 "Escucha": grabación máx. 3 s + espera de la nube 6 s (07), contada desde el fin de la grabación */
#define LISTEN_RECORD_MAX_S           3.0f
#define LISTEN_CLOUD_WAIT_S           6.0f
#define LISTEN_TIMEOUT_S              (LISTEN_RECORD_MAX_S + LISTEN_CLOUD_WAIT_S)

#endif
