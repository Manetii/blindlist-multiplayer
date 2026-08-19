-- ════════════════════════════════════════════════════════════════
--  008 — Deux façons d'alimenter une soirée
-- ════════════════════════════════════════════════════════════════
--
--  MODE FICHIERS (existant) — chacun cherche ses morceaux dans les
--  catalogues, l'hôte récupère les fichiers audio et les apparie. La
--  soirée tourne ensuite hors ligne, ce qui est sa grande qualité :
--  une fois le dossier chargé, plus rien ne peut lâcher.
--
--  MODE YOUTUBE — chacun colle une URL et saisit titre et artiste. Rien
--  à télécharger, rien à apparier : on gagne l'étape qui décourageait,
--  au prix d'un peu de travail côté participant et d'une dépendance au
--  réseau pendant la partie.
--
--  Le mode se choisit à la création et se corrige tant que PERSONNE n'a
--  encore proposé de morceau. Au-delà, il est figé : un panier constitué
--  en mode fichiers n'a pas d'URL de vidéo, un panier YouTube n'a pas de
--  fichier, et rien ne permet de traduire l'un dans l'autre. Basculer en
--  cours de collecte reviendrait à effacer le travail déjà fait.
--
--  Pas de type énuméré : un CHECK se modifie par une migration ordinaire
--  là où un ALTER TYPE se négocie avec les transactions en cours.
-- ════════════════════════════════════════════════════════════════

ALTER TABLE parties
  ADD COLUMN source_mode text NOT NULL DEFAULT 'fichiers'
    CONSTRAINT source_mode_known CHECK (source_mode IN ('fichiers', 'youtube'));

COMMENT ON COLUMN parties.source_mode IS
  'fichiers = recherche catalogue + MP3 locaux ; youtube = URL collées, lecture en ligne';
