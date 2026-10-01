-- Contribution ouverte : liens de contribution, contributeurs, relecteurs, propositions, historique des
-- modifications et limites d'envoi. Relançable sans casse : chaque ajout vérifie d'abord ce qui existe,
-- avec une syntaxe commune à MariaDB et MySQL 8.

CREATE TABLE IF NOT EXISTS contribution_links (
  id VARCHAR(32) NOT NULL,
  label VARCHAR(80) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  is_public BOOLEAN NOT NULL DEFAULT FALSE,
  created_at DATETIME(3) NOT NULL,
  closed_at DATETIME(3) NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS contributors (
  id VARCHAR(36) NOT NULL,
  device_digest BINARY(32) NOT NULL,
  link_id VARCHAR(32) NOT NULL,
  pseudonym VARCHAR(40) NULL,
  `status` VARCHAR(16) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  last_seen_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY contributors_device_digest (device_digest),
  KEY contributors_last_seen_at (last_seen_at),
  CONSTRAINT contributors_link FOREIGN KEY (link_id) REFERENCES contribution_links (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS reviewers (
  id VARCHAR(36) NOT NULL,
  name VARCHAR(80) NOT NULL,
  token_digest BINARY(32) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at DATETIME(3) NOT NULL,
  revoked_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY reviewers_token_digest (token_digest)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS proposals (
  id VARCHAR(36) NOT NULL,
  contributor_id VARCHAR(36) NULL,
  entity_type VARCHAR(8) NOT NULL,
  `action` VARCHAR(8) NOT NULL,
  target_id VARCHAR(64) NULL,
  target_updated_at DATETIME(3) NULL,
  payload JSON NOT NULL,
  position_accuracy_meters DOUBLE NOT NULL,
  `status` VARCHAR(12) NOT NULL,
  reviewer_kind VARCHAR(8) NULL,
  reviewer_id VARCHAR(36) NULL,
  review_note VARCHAR(300) NULL,
  created_at DATETIME(3) NOT NULL,
  reviewed_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  KEY proposals_status_created_at (`status`, created_at),
  KEY proposals_contributor_id (contributor_id),
  CONSTRAINT proposals_contributor FOREIGN KEY (contributor_id) REFERENCES contributors (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS map_changes (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  entity_type VARCHAR(8) NOT NULL,
  entity_id VARCHAR(64) NULL,
  `action` VARCHAR(8) NOT NULL,
  before_state JSON NULL,
  after_state JSON NULL,
  actor_kind VARCHAR(12) NOT NULL,
  actor_id VARCHAR(36) NULL,
  proposal_id VARCHAR(36) NULL,
  reverts_change_id BIGINT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  KEY map_changes_entity (entity_type, entity_id),
  KEY map_changes_created_at (created_at),
  CONSTRAINT map_changes_proposal FOREIGN KEY (proposal_id) REFERENCES proposals (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS rate_limits (
  limit_kind VARCHAR(32) NOT NULL,
  subject_digest BINARY(32) NOT NULL,
  attempt_count INT UNSIGNED NOT NULL,
  reset_at DATETIME(3) NOT NULL,
  PRIMARY KEY (limit_kind, subject_digest),
  KEY rate_limits_reset_at (reset_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET @migration_statement = IF(
  (SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'campus_settings' AND column_name = 'perimeter') = 0,
  'ALTER TABLE campus_settings ADD COLUMN perimeter JSON NULL',
  'DO 0'
);
PREPARE migration_step FROM @migration_statement;
EXECUTE migration_step;
DEALLOCATE PREPARE migration_step;

SET @migration_statement = IF(
  (SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'campus_settings' AND column_name = 'contributions_paused') = 0,
  'ALTER TABLE campus_settings ADD COLUMN contributions_paused BOOLEAN NOT NULL DEFAULT FALSE',
  'DO 0'
);
PREPARE migration_step FROM @migration_statement;
EXECUTE migration_step;
DEALLOCATE PREPARE migration_step;

SET @migration_statement = IF(
  (SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'admin_sessions' AND column_name = 'actor_kind') = 0,
  'ALTER TABLE admin_sessions ADD COLUMN actor_kind VARCHAR(12) NOT NULL DEFAULT ''admin''',
  'DO 0'
);
PREPARE migration_step FROM @migration_statement;
EXECUTE migration_step;
DEALLOCATE PREPARE migration_step;

SET @migration_statement = IF(
  (SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'admin_sessions' AND column_name = 'reviewer_id') = 0,
  'ALTER TABLE admin_sessions ADD COLUMN reviewer_id VARCHAR(36) NULL',
  'DO 0'
);
PREPARE migration_step FROM @migration_statement;
EXECUTE migration_step;
DEALLOCATE PREPARE migration_step;

SET @migration_statement = IF(
  (SELECT COUNT(*) FROM information_schema.table_constraints
   WHERE constraint_schema = DATABASE() AND table_name = 'admin_sessions'
     AND constraint_name = 'admin_sessions_reviewer') = 0,
  'ALTER TABLE admin_sessions ADD CONSTRAINT admin_sessions_reviewer FOREIGN KEY (reviewer_id) REFERENCES reviewers (id) ON DELETE CASCADE',
  'DO 0'
);
PREPARE migration_step FROM @migration_statement;
EXECUTE migration_step;
DEALLOCATE PREPARE migration_step;
