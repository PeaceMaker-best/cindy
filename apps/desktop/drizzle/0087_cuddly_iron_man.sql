CREATE TABLE IF NOT EXISTS `session_deletion_finalizations` (
	`session_id` text PRIMARY KEY NOT NULL,
	`finalized_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
