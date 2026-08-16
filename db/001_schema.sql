-- ════════════════════════════════════════════════════════════════
--  BLIND TEST PARTY — Schéma phase 2 (PostgreSQL 14+)
-- ════════════════════════════════════════════════════════════════
--
--  Deux couches, deux régimes :
--
--    PERSISTANT (ici)     La soirée, ses participants, leurs morceaux.
--                         Vit des semaines. Source de vérité.
--
--    ÉPHÉMÈRE (en RAM)    Le salon : sockets, votes en cours, écran
--                         courant. Vit quelques heures. Reconstruit
--                         depuis la base à l'ouverture.
--
--  Les tables sessions / rounds / votes / score_events sont l'EMPREINTE
--  du salon, pas son moteur. Elles sont écrites au reveal de chaque
--  manche — pas à chaque vote — pour ne pas mettre la base dans le
--  chemin critique du jeu.
--
--  AUCUNE EXTENSION REQUISE.
--    gen_random_uuid() fait partie du cœur de PostgreSQL depuis la
--    version 13 — pgcrypto n'est pas nécessaire.
--    La normalisation des pseudos (accents, casse) est faite en
--    JavaScript dans server/lib/identity.js, pas par unaccent.
--
--    Conséquence : ce schéma s'applique avec un rôle ORDINAIRE, sans
--    privilèges SUPERUSER. Il fonctionne donc tel quel sur n'importe
--    quel PostgreSQL hébergé (Neon, Supabase, Render…), où la création
--    d'extensions est souvent interdite.
-- ════════════════════════════════════════════════════════════════


-- ─── Types ──────────────────────────────────────────────────────

CREATE TYPE party_state AS ENUM (
  'collecte',     -- paniers ouverts, les participants ajoutent des morceaux
  'verrouillee',  -- envois clos, numéros d'acquisition attribués
  'prete',        -- fichiers en place et vérifiés, le salon peut ouvrir
  'terminee',     -- au moins une session jouée et close
  'archivee'      -- sortie de la circulation, conservée en lecture seule
);

CREATE TYPE track_state AS ENUM (
  'proposed',   -- dans le panier d'un participant
  'duplicate',  -- même morceau proposé par quelqu'un d'autre — à arbitrer
  'excluded',   -- écarté par l'hôte (doublon perdant, morceau inadapté…)
  'locked',     -- retenu pour la partie, acquisition_no attribué
  'downloaded', -- fichier présent dans le dossier de l'hôte
  'verified',   -- fichier présent ET durée cohérente avec les métadonnées
  'missing'     -- attendu mais introuvable après téléchargement
);

CREATE TYPE track_source AS ENUM (
  'spotify', 'deezer', 'itunes', 'musicbrainz', 'youtube', 'manual'
);

CREATE TYPE score_reason AS ENUM (
  'finder',   -- R1 — a trouvé le bon proposant
  'bluffer',  -- R2 — a été désigné à tort
  'trapper',  -- R3 — règle optionnelle du piégeur
  'manual'    -- ajustement ±1 de l'hôte
);


-- ════════════════════════════════════════════════════════════════
--  PARTIES — la soirée
-- ════════════════════════════════════════════════════════════════
--
--  UN SEUL CODE POUR TOUT. Le code porté ici sert à la fois à
--  rejoindre la collecte (des semaines avant) et à rejoindre le salon
--  le soir venu. Deux codes distincts — un pour proposer, un pour
--  jouer — seraient une source de confusion garantie pour les
--  participants. Le salon hérite du code de sa soirée.

CREATE TABLE parties (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Alphabet sans caractères ambigus : ni I, ni O, ni 0, ni 1.
  -- Identique à celui de server/rooms.js pour que le code reste
  -- dictable à voix haute sans malentendu.
  code                     text NOT NULL UNIQUE
                             CHECK (code ~ '^[A-HJ-NP-Z2-9]{4,6}$'),

  name                     text NOT NULL
                             CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),

  state                    party_state NOT NULL DEFAULT 'collecte',

  -- Preuve de propriété de la soirée, détenue par le NAVIGATEUR qui l'a
  -- créée (le PC de gestion), pas par une identité de joueur.
  --
  -- L'hôte utilise deux appareils avec deux rôles disjoints : son PC
  -- pilote la partie (ce jeton), son téléphone joue comme n'importe quel
  -- participant (jeton de participants). Les confondre obligerait à
  -- choisir un seul appareil ; les séparer supprime le cas particulier.
  host_token_hash          bytea NOT NULL,

  -- Fourchette de morceaux par participant, plutôt qu'un nombre fixe.
  --   min : pousse chacun à montrer ses goûts, définit « panier
  --         incomplet » de façon objective au moment du verrouillage
  --   max : empêche qu'une seule personne monopolise la playlist
  min_tracks_per_person    smallint NOT NULL DEFAULT 3
                             CHECK (min_tracks_per_person BETWEEN 1 AND 20),
  max_tracks_per_person    smallint NOT NULL DEFAULT 6
                             CHECK (max_tracks_per_person BETWEEN 1 AND 20),

  -- Automatismes de partie. Le PC de l'hôte n'a idéalement rien à faire
  -- pendant une manche : les téléphones pilotent le rythme.
  auto_reveal_on_all_votes boolean NOT NULL DEFAULT true,
  auto_advance_on_all_ready boolean NOT NULL DEFAULT true,

  -- false (défaut) : l'hôte crée la liste des participants, chacun
  --   revendique son nom via le lien partagé /j/<code>.
  -- true : n'importe qui ouvrant le lien peut créer son propre nom.
  allow_self_registration  boolean  NOT NULL DEFAULT false,

  rule_trapper_enabled     boolean  NOT NULL DEFAULT false,

  created_at               timestamptz NOT NULL DEFAULT now(),
  last_activity_at         timestamptz NOT NULL DEFAULT now(),
  locked_at                timestamptz,
  archived_at              timestamptz,

  CONSTRAINT archived_state_consistent
    CHECK (archived_at IS NULL OR state = 'archivee'),
  CONSTRAINT locked_before_archived
    CHECK (locked_at IS NULL OR archived_at IS NULL OR locked_at <= archived_at),
  CONSTRAINT track_range_coherent
    CHECK (min_tracks_per_person <= max_tracks_per_person)
);

-- Purge : les soirées inactives depuis longtemps. Le TTL de la soirée
-- (semaines) n'a rien à voir avec celui du salon (heures) — c'est
-- précisément pourquoi les deux objets sont séparés.
CREATE INDEX parties_activity_idx ON parties (last_activity_at)
  WHERE archived_at IS NULL;

-- Recherche par code : seuls les codes des soirées vivantes doivent
-- répondre, mais l'unicité doit rester globale pour éviter qu'un code
-- archivé soit réattribué et sème la confusion chez les habitués.


-- ════════════════════════════════════════════════════════════════
--  PARTICIPANTS — identité durable
-- ════════════════════════════════════════════════════════════════
--
--  À ne pas confondre avec le « joueur en salon » (en RAM). Un
--  participant peut avoir proposé des morceaux sans être présent le
--  soir J ; inversement personne ne joue sans être participant.
--
--  display_name est À LA FOIS la clé d'entrée et la réponse du jeu.
--  D'où name_key : forme normalisée (minuscules, sans accents, espaces
--  compressés) sur laquelle porte l'unicité. Sans elle, « Camille » et
--  « camille » créeraient deux participants distincts, dont l'un
--  détiendrait des morceaux orphelins.
--
--  ─── REVENDICATION EN DEUX TEMPS ──────────────────────────────
--  L'hôte crée les participants sans jeton (token_hash NULL). Il ne
--  peut pas faire autrement : il ignore qui ouvrira quel lien. Il
--  diffuse donc UN lien partagé, /j/<code>, et chacun choisit son nom
--  dans la liste. Ce choix REVENDIQUE l'identité : le serveur émet
--  alors un jeton personnel, et le nom devient inaccessible aux autres.
--
--  Une identité revendiquée est verrouillée — c'est ce qui empêche
--  deux appareils de se disputer un pseudo, contrairement au modèle
--  actuel où le pseudo est libre à chaque connexion. L'hôte peut
--  libérer une revendication (RAZ des deux colonnes) si quelqu'un a
--  cliqué sur le mauvais nom.

CREATE TABLE participants (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  party_id       uuid NOT NULL REFERENCES parties(id) ON DELETE CASCADE,

  display_name   text NOT NULL
                   CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 24),
  name_key       text NOT NULL,   -- lower(unaccent(trim(display_name)))

  color          text NOT NULL CHECK (color ~ '^#[0-9a-fA-F]{6}$'),

  -- Lien magique personnel, émis À LA REVENDICATION, pas à la création.
  -- On stocke le HACHÉ, jamais le jeton en clair : une fuite de la base
  -- ne doit pas donner accès aux paniers.
  -- URL servie au participant une fois revendiqué : /p/<code>/<jeton>
  token_hash     bytea,
  claimed_at     timestamptz,

  -- true : saisi à la main par l'hôte pour quelqu'un qui n'utilisera
  -- pas l'app (« Papy »). L'hôte gère alors ses morceaux à sa place.
  is_managed     boolean NOT NULL DEFAULT false,

  created_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz,

  CONSTRAINT unique_name_per_party UNIQUE (party_id, name_key),

  -- Un jeton existe si et seulement si l'identité a été revendiquée.
  -- Interdit structurellement les deux états bâtards : jeton sans
  -- revendication, ou revendication sans moyen de preuve.
  CONSTRAINT token_matches_claim
    CHECK ((token_hash IS NULL) = (claimed_at IS NULL)),

  -- Permet aux tables filles de référencer le couple (party_id, id)
  -- et donc d'interdire structurellement les rattachements croisés
  -- entre soirées. Voir tracks.
  CONSTRAINT participants_party_scoped UNIQUE (party_id, id)
);

-- Partiel : plusieurs participants peuvent être non revendiqués (NULL),
-- mais deux jetons identiques sont impossibles.
CREATE UNIQUE INDEX participants_token_idx
  ON participants (token_hash) WHERE token_hash IS NOT NULL;

-- Liste des noms encore libres, affichée sur l'écran de revendication.
CREATE INDEX participants_unclaimed_idx
  ON participants (party_id) WHERE claimed_at IS NULL;


-- ════════════════════════════════════════════════════════════════
--  TRACKS — les morceaux proposés
-- ════════════════════════════════════════════════════════════════
--
--  Remplace intégralement le CSV + le matching flou de /prepare.
--  L'association morceau ↔ joueur n'est plus déduite après coup :
--  elle est native, puisque c'est le participant lui-même qui saisit.
--
--  acquisition_no est LA CLÉ DE JOINTURE avec les fichiers. Attribué
--  au verrouillage, il devient le préfixe du nom de fichier attendu
--  (001__Daft_Punk__Around_the_World.mp3). Un identifiant numérique
--  survit à n'importe quel massacre du reste du nom par l'outil de
--  téléchargement — contrairement aux tags ID3.

CREATE TABLE tracks (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  party_id          uuid NOT NULL,
  participant_id    uuid NOT NULL,

  position          smallint NOT NULL CHECK (position > 0),  -- rang dans le panier
  acquisition_no    smallint CHECK (acquisition_no > 0),     -- rang global, NULL avant verrouillage

  -- Provenance
  source            track_source NOT NULL,
  source_id         text NOT NULL,   -- URI Spotify, MBID, id Deezer…

  -- Métadonnées (issues de l'API, pas de l'ID3)
  title             text NOT NULL CHECK (char_length(btrim(title)) > 0),
  artist            text NOT NULL CHECK (char_length(btrim(artist)) > 0),
  album             text,
  duration_ms       integer CHECK (duration_ms > 0),
  artwork_url       text,

  -- Le « moment clé » n'est PAS stocké ici. Décision de conception :
  -- c'est une décision de mise en scène (difficulté voulue, longueur de
  -- l'intro, enchaînement des refrains), pas une propriété du morceau.
  -- La demander au participant au moment où il compose son panier
  -- ajouterait une friction par titre, sans qu'il puisse écouter.
  -- L'hôte décide au ressenti pendant la partie ; l'offset réellement
  -- utilisé est consigné dans rounds.start_offset_ms.

  state             track_state NOT NULL DEFAULT 'proposed',

  -- Rapprochement avec le fichier local
  file_name         text,      -- nom canonique attendu
  file_duration_ms  integer,   -- mesuré via decodeAudioData après téléchargement

  created_at        timestamptz NOT NULL DEFAULT now(),

  -- Le couple (party_id, participant_id) doit désigner un participant
  -- DE CETTE soirée. Sans cette FK composite, rien n'empêcherait au
  -- niveau base d'attribuer un morceau à quelqu'un d'une autre soirée.
  CONSTRAINT tracks_participant_fk
    FOREIGN KEY (party_id, participant_id)
    REFERENCES participants (party_id, id) ON DELETE CASCADE,

  CONSTRAINT unique_position_in_basket UNIQUE (participant_id, position),
  CONSTRAINT unique_acquisition_no     UNIQUE (party_id, acquisition_no),

  -- Le numéro d'acquisition n'existe qu'une fois le morceau retenu.
  CONSTRAINT acquisition_no_when_locked
    CHECK ((acquisition_no IS NULL) = (state IN ('proposed','duplicate','excluded'))),

  -- La durée mesurée n'a de sens qu'une fois le fichier là.
  CONSTRAINT file_duration_when_downloaded
    CHECK (file_duration_ms IS NULL OR state IN ('downloaded','verified','missing'))
);

-- Détection des doublons inter-joueurs. VOLONTAIREMENT non unique :
-- deux personnes peuvent proposer le même titre, et c'est à l'hôte
-- d'arbitrer (le jeu ne peut pas avoir deux bonnes réponses pour un
-- même morceau). L'index sert à lever l'alerte au moment du
-- verrouillage, pas à interdire la saisie.
CREATE INDEX tracks_duplicate_idx ON tracks (party_id, source, source_id);

CREATE INDEX tracks_by_participant ON tracks (participant_id, position);
CREATE INDEX tracks_pending_idx    ON tracks (party_id) WHERE state = 'missing';


-- ════════════════════════════════════════════════════════════════
--  SESSIONS — une soirée de jeu effective
-- ════════════════════════════════════════════════════════════════
--
--  Empreinte du salon. Une soirée peut en engendrer plusieurs :
--  reprise après un plantage, ou seconde soirée avec la même playlist.

CREATE TABLE sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  party_id    uuid NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
  opened_at   timestamptz NOT NULL DEFAULT now(),
  closed_at   timestamptz,

  CONSTRAINT closed_after_opened
    CHECK (closed_at IS NULL OR closed_at >= opened_at)
);

-- Un seul salon ouvert à la fois par soirée : deux salons concurrents
-- sur la même playlist produiraient deux podiums contradictoires.
CREATE UNIQUE INDEX one_open_session_per_party
  ON sessions (party_id) WHERE closed_at IS NULL;


-- ════════════════════════════════════════════════════════════════
--  ROUNDS — une manche jouée
-- ════════════════════════════════════════════════════════════════

CREATE TABLE rounds (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id   uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  track_id     uuid NOT NULL REFERENCES tracks(id),
  order_no     smallint NOT NULL CHECK (order_no > 0),

  -- Où la lecture a effectivement démarré ce soir-là. Alimenté par
  -- l'heuristique (25 % de la durée, plafonné à 50 s) puis ajusté au
  -- ressenti par l'hôte pendant la manche. Consigné a posteriori : si
  -- la même playlist est rejouée, on sait quels morceaux ont eu besoin
  -- d'être avancés.
  start_offset_ms  integer CHECK (start_offset_ms >= 0),

  started_at   timestamptz NOT NULL DEFAULT now(),
  revealed_at  timestamptz,

  CONSTRAINT unique_order_in_session UNIQUE (session_id, order_no),
  -- Un morceau ne se joue qu'une fois par session.
  CONSTRAINT unique_track_in_session UNIQUE (session_id, track_id)
);


-- ════════════════════════════════════════════════════════════════
--  VOTES
-- ════════════════════════════════════════════════════════════════
--
--  Écrits en bloc au reveal, depuis l'état RAM du salon. Pendant la
--  manche, les votes vivent dans la Map du salon : aucune écriture
--  base dans le chemin critique.

CREATE TABLE votes (
  round_id   uuid NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  voter_id   uuid NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  voted_id   uuid NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  cast_at    timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (round_id, voter_id),          -- un vote par manche et par joueur
  CONSTRAINT no_self_vote CHECK (voter_id <> voted_id)
);

CREATE INDEX votes_by_voted ON votes (voted_id);


-- ════════════════════════════════════════════════════════════════
--  SCORE_EVENTS — le score comme journal, pas comme compteur
-- ════════════════════════════════════════════════════════════════
--
--  On stocke les DELTAS motivés plutôt qu'un total. Trois bénéfices :
--    - le podium est reconstructible et auditable (« pourquoi 7 ? »)
--    - les ajustements manuels de l'hôte sont tracés comme tels
--    - rejouer le calcul après correction d'un bug reste possible
--
--  Le plancher à zéro de l'ancien code (Math.max(0, …)) n'est pas
--  reproduit : un total peut descendre sous zéro si l'hôte le décide.

CREATE TABLE score_events (
  id              bigserial PRIMARY KEY,
  round_id        uuid NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  participant_id  uuid NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  points          smallint NOT NULL CHECK (points <> 0),
  reason          score_reason NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX score_events_by_round ON score_events (round_id);
CREATE INDEX score_events_by_part  ON score_events (participant_id);


-- ════════════════════════════════════════════════════════════════
--  VUES
-- ════════════════════════════════════════════════════════════════

-- Tableau de complétion affiché à l'hôte pendant la collecte.
CREATE VIEW v_party_progress AS
SELECT
  p.id                AS party_id,
  p.code,
  p.state,
  pa.id               AS participant_id,
  pa.display_name,
  pa.is_managed,
  count(t.id) FILTER (WHERE t.state <> 'excluded')          AS tracks_submitted,
  p.min_tracks_per_person,
  p.max_tracks_per_person,
  count(t.id) FILTER (WHERE t.state <> 'excluded')
    >= p.min_tracks_per_person                              AS meets_minimum,
  count(t.id) FILTER (WHERE t.state = 'verified')            AS tracks_verified,
  pa.last_seen_at
FROM parties p
JOIN participants pa ON pa.party_id = p.id
LEFT JOIN tracks  t  ON t.participant_id = pa.id
GROUP BY p.id, pa.id;

-- Classement d'une session, reconstruit depuis le journal.
CREATE VIEW v_session_standings AS
SELECT
  s.id                      AS session_id,
  pa.id                     AS participant_id,
  pa.display_name,
  pa.color,
  coalesce(sum(se.points), 0)::integer AS score
FROM sessions s
JOIN participants pa ON pa.party_id = s.party_id
LEFT JOIN rounds r      ON r.session_id = s.id
LEFT JOIN score_events se ON se.round_id = r.id
                        AND se.participant_id = pa.id
GROUP BY s.id, pa.id;

-- Effectif poussé dans le salon à son ouverture.
--
-- can_be_answer distingue les participants qui peuvent être la bonne
-- réponse de ceux qui jouent en pure devinette (retardataires arrivés
-- après le verrouillage, sans morceau).
--
-- POURQUOI C'EST NÉCESSAIRE : la règle du bluffeur donne un point par
-- joueur qui vous désigne à tort. Un participant sans morceau ne peut
-- JAMAIS être la bonne réponse — tout vote pour lui est donc faux par
-- construction, et il encaisserait des points sans rien faire. Il doit
-- être retiré de la grille de vote, pas seulement du calcul.
CREATE VIEW v_salon_roster AS
SELECT
  pa.party_id,
  pa.id            AS participant_id,
  pa.display_name,
  pa.color,
  pa.claimed_at IS NOT NULL AS claimed,
  count(t.id) FILTER (WHERE t.state IN ('locked','downloaded','verified')) > 0
                   AS can_be_answer
FROM participants pa
LEFT JOIN tracks t ON t.participant_id = pa.id
GROUP BY pa.id;

-- Manifeste d'acquisition : ce que l'hôte exporte pour télécharger.
-- Le nom de fichier canonique est calculé ici, pas côté application,
-- pour que l'export et la vérification partagent la même définition.
CREATE VIEW v_acquisition_manifest AS
SELECT
  t.party_id,
  t.acquisition_no,
  lpad(t.acquisition_no::text, 3, '0') || '__' ||
    regexp_replace(t.artist, '[^A-Za-z0-9]+', '_', 'g') || '__' ||
    regexp_replace(t.title,  '[^A-Za-z0-9]+', '_', 'g') || '.mp3'
                       AS expected_file_name,
  t.artist, t.title, t.album, t.duration_ms,
  t.source, t.source_id,
  pa.display_name      AS proposed_by,
  t.state
FROM tracks t
JOIN participants pa ON pa.id = t.participant_id
WHERE t.acquisition_no IS NOT NULL
ORDER BY t.acquisition_no;


-- ════════════════════════════════════════════════════════════════
--  REQUÊTES D'EXPLOITATION
-- ════════════════════════════════════════════════════════════════

-- Doublons à arbitrer avant de verrouiller.
--   SELECT source, source_id, title, artist,
--          array_agg(pa.display_name) AS proposed_by
--   FROM tracks t JOIN participants pa ON pa.id = t.participant_id
--   WHERE t.party_id = $1 AND t.state = 'proposed'
--   GROUP BY source, source_id, title, artist
--   HAVING count(*) > 1;

-- Écart de durée suspect après téléchargement (mauvais morceau récupéré).
--   UPDATE tracks SET state = 'missing'
--   WHERE state = 'downloaded'
--     AND abs(file_duration_ms - duration_ms) > 3000;

-- Purge des soirées dormantes (à planifier).
--   UPDATE parties SET state = 'archivee', archived_at = now()
--   WHERE archived_at IS NULL AND last_activity_at < now() - interval '90 days';
--   DELETE FROM parties
--   WHERE archived_at IS NOT NULL AND archived_at < now() - interval '1 year';
