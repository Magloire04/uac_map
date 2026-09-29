-- Schéma initial : carte (lieux, chemins, réglages), sessions du mode collecte et compteurs d'échecs.
-- Relançable sans casse : MariaDB valide chaque CREATE TABLE immédiatement, sans retour arrière possible.

CREATE TABLE IF NOT EXISTS places (
  id VARCHAR(64) NOT NULL,
  name VARCHAR(120) NOT NULL,
  category VARCHAR(32) NOT NULL,
  aliases JSON NOT NULL,
  description VARCHAR(1000) NOT NULL DEFAULT '',
  `access` VARCHAR(300) NOT NULL DEFAULT '',
  longitude DOUBLE NOT NULL,
  latitude DOUBLE NOT NULL,
  entrances JSON NOT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  KEY places_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS paths (
  id VARCHAR(64) NOT NULL,
  `type` VARCHAR(32) NOT NULL,
  name VARCHAR(120) NOT NULL DEFAULT '',
  is_flood_prone BOOLEAN NOT NULL DEFAULT FALSE,
  coordinates JSON NOT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS campus_settings (
  id TINYINT UNSIGNED NOT NULL,
  name VARCHAR(120) NOT NULL,
  center_longitude DOUBLE NOT NULL,
  center_latitude DOUBLE NOT NULL,
  zoom DOUBLE NOT NULL,
  is_demo BOOLEAN NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT campus_settings_single_row CHECK (id = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS admin_sessions (
  session_digest BINARY(32) NOT NULL,
  token_fingerprint BINARY(32) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (session_digest),
  KEY admin_sessions_expires_at (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS failed_login_attempts (
  client_digest BINARY(32) NOT NULL,
  failure_count INT UNSIGNED NOT NULL,
  reset_at DATETIME(3) NOT NULL,
  PRIMARY KEY (client_digest),
  KEY failed_login_attempts_reset_at (reset_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
