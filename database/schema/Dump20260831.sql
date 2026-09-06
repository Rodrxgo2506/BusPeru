CREATE DATABASE  IF NOT EXISTS `busperu` /*!40100 DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci */;
USE `busperu`;
-- MySQL dump 10.13  Distrib 8.0.46, for Win64 (x86_64)
--
-- Host: 127.0.0.1    Database: busperu
-- ------------------------------------------------------
-- Server version	5.5.5-10.4.32-MariaDB

/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!50503 SET NAMES utf8 */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
/*!40103 SET TIME_ZONE='+00:00' */;
/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;
/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;

--
-- Table structure for table `api_keys`
--

DROP TABLE IF EXISTS `api_keys`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `api_keys` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `company_id` int(10) unsigned DEFAULT NULL,
  `user_id` int(10) unsigned DEFAULT NULL,
  `name` varchar(150) NOT NULL,
  `key_prefix` varchar(20) NOT NULL,
  `key_hash` varchar(255) NOT NULL,
  `environment` enum('TEST','PRODUCTION') NOT NULL DEFAULT 'TEST',
  `permissions` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`permissions`)),
  `last_used_at` datetime DEFAULT NULL,
  `expires_at` datetime DEFAULT NULL,
  `status` enum('ACTIVE','REVOKED','EXPIRED') NOT NULL DEFAULT 'ACTIVE',
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `key_hash` (`key_hash`),
  KEY `idx_api_keys_company` (`company_id`),
  KEY `idx_api_keys_user` (`user_id`),
  KEY `idx_api_keys_prefix` (`key_prefix`),
  KEY `idx_api_keys_environment` (`environment`),
  KEY `idx_api_keys_status` (`status`),
  KEY `idx_api_keys_expires_at` (`expires_at`),
  CONSTRAINT `fk_api_keys_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_api_keys_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `api_keys`
--

LOCK TABLES `api_keys` WRITE;
/*!40000 ALTER TABLE `api_keys` DISABLE KEYS */;
/*!40000 ALTER TABLE `api_keys` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `audit_logs`
--

DROP TABLE IF EXISTS `audit_logs`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `audit_logs` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `user_id` int(10) unsigned DEFAULT NULL,
  `action` varchar(100) NOT NULL,
  `entity_type` varchar(100) DEFAULT NULL,
  `entity_id` int(10) unsigned DEFAULT NULL,
  `description` varchar(500) DEFAULT NULL,
  `old_values` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`old_values`)),
  `new_values` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`new_values`)),
  `ip_address` varchar(45) DEFAULT NULL,
  `user_agent` varchar(500) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_audit_logs_user` (`user_id`),
  KEY `idx_audit_logs_action` (`action`),
  KEY `idx_audit_logs_entity` (`entity_type`,`entity_id`),
  KEY `idx_audit_logs_created_at` (`created_at`),
  CONSTRAINT `fk_audit_logs_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `audit_logs`
--

LOCK TABLES `audit_logs` WRITE;
/*!40000 ALTER TABLE `audit_logs` DISABLE KEYS */;
/*!40000 ALTER TABLE `audit_logs` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `booking_seats`
--

DROP TABLE IF EXISTS `booking_seats`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `booking_seats` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `booking_id` int(10) unsigned NOT NULL,
  `trip_id` int(10) unsigned NOT NULL,
  `seat_id` int(10) unsigned NOT NULL,
  `price` decimal(10,2) NOT NULL,
  `passenger_name` varchar(200) DEFAULT NULL,
  `passenger_document` varchar(50) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_booking_seats_booking` (`booking_id`),
  KEY `idx_booking_seats_trip` (`trip_id`),
  KEY `idx_booking_seats_seat` (`seat_id`),
  KEY `idx_booking_seats_availability` (`trip_id`,`seat_id`),
  CONSTRAINT `fk_booking_seats_booking` FOREIGN KEY (`booking_id`) REFERENCES `bookings` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_booking_seats_seat` FOREIGN KEY (`seat_id`) REFERENCES `seats` (`id`) ON UPDATE CASCADE,
  CONSTRAINT `fk_booking_seats_trip` FOREIGN KEY (`trip_id`) REFERENCES `trips` (`id`) ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `booking_seats`
--

LOCK TABLES `booking_seats` WRITE;
/*!40000 ALTER TABLE `booking_seats` DISABLE KEYS */;
/*!40000 ALTER TABLE `booking_seats` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `bookings`
--

DROP TABLE IF EXISTS `bookings`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `bookings` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `booking_code` varchar(30) NOT NULL,
  `user_id` int(10) unsigned NOT NULL,
  `trip_id` int(10) unsigned NOT NULL,
  `origin_stop_id` int(10) unsigned DEFAULT NULL,
  `destination_stop_id` int(10) unsigned DEFAULT NULL,
  `passenger_count` smallint(5) unsigned NOT NULL DEFAULT 1,
  `subtotal` decimal(10,2) NOT NULL,
  `discount_amount` decimal(10,2) NOT NULL DEFAULT 0.00,
  `service_fee` decimal(10,2) NOT NULL DEFAULT 0.00,
  `total_amount` decimal(10,2) NOT NULL,
  `status` enum('PENDING','CONFIRMED','CANCELLED','COMPLETED','EXPIRED') NOT NULL DEFAULT 'PENDING',
  `passenger_name` varchar(200) DEFAULT NULL,
  `passenger_document` varchar(50) DEFAULT NULL,
  `passenger_phone` varchar(30) DEFAULT NULL,
  `passenger_email` varchar(150) DEFAULT NULL,
  `notes` varchar(500) DEFAULT NULL,
  `expires_at` datetime DEFAULT NULL,
  `confirmed_at` datetime DEFAULT NULL,
  `cancelled_at` datetime DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `booking_code` (`booking_code`),
  KEY `fk_bookings_origin_stop` (`origin_stop_id`),
  KEY `fk_bookings_destination_stop` (`destination_stop_id`),
  KEY `idx_bookings_user` (`user_id`),
  KEY `idx_bookings_trip` (`trip_id`),
  KEY `idx_bookings_status` (`status`),
  KEY `idx_bookings_created_at` (`created_at`),
  KEY `idx_bookings_code` (`booking_code`),
  CONSTRAINT `fk_bookings_destination_stop` FOREIGN KEY (`destination_stop_id`) REFERENCES `route_stops` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_bookings_origin_stop` FOREIGN KEY (`origin_stop_id`) REFERENCES `route_stops` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_bookings_trip` FOREIGN KEY (`trip_id`) REFERENCES `trips` (`id`) ON UPDATE CASCADE,
  CONSTRAINT `fk_bookings_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `bookings`
--

LOCK TABLES `bookings` WRITE;
/*!40000 ALTER TABLE `bookings` DISABLE KEYS */;
/*!40000 ALTER TABLE `bookings` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `bus_types`
--

DROP TABLE IF EXISTS `bus_types`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `bus_types` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `name` varchar(100) NOT NULL,
  `description` varchar(255) DEFAULT NULL,
  `default_capacity` smallint(5) unsigned DEFAULT NULL,
  `status` enum('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `name` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `bus_types`
--

LOCK TABLES `bus_types` WRITE;
/*!40000 ALTER TABLE `bus_types` DISABLE KEYS */;
/*!40000 ALTER TABLE `bus_types` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `buses`
--

DROP TABLE IF EXISTS `buses`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `buses` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `company_id` int(10) unsigned NOT NULL,
  `bus_type_id` int(10) unsigned DEFAULT NULL,
  `code` varchar(50) NOT NULL,
  `plate_number` varchar(20) NOT NULL,
  `brand` varchar(100) DEFAULT NULL,
  `model` varchar(100) DEFAULT NULL,
  `year` smallint(5) unsigned DEFAULT NULL,
  `capacity` smallint(5) unsigned NOT NULL,
  `amenities` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`amenities`)),
  `status` enum('ACTIVE','INACTIVE','MAINTENANCE') NOT NULL DEFAULT 'ACTIVE',
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `plate_number` (`plate_number`),
  KEY `idx_buses_company` (`company_id`),
  KEY `idx_buses_type` (`bus_type_id`),
  KEY `idx_buses_status` (`status`),
  CONSTRAINT `fk_buses_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_buses_type` FOREIGN KEY (`bus_type_id`) REFERENCES `bus_types` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `buses`
--

LOCK TABLES `buses` WRITE;
/*!40000 ALTER TABLE `buses` DISABLE KEYS */;
/*!40000 ALTER TABLE `buses` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `companies`
--

DROP TABLE IF EXISTS `companies`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `companies` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `name` varchar(150) NOT NULL,
  `legal_name` varchar(200) DEFAULT NULL,
  `tax_id` varchar(30) DEFAULT NULL,
  `email` varchar(150) DEFAULT NULL,
  `phone` varchar(30) DEFAULT NULL,
  `logo_url` varchar(500) DEFAULT NULL,
  `description` text DEFAULT NULL,
  `status` enum('PENDING','ACTIVE','INACTIVE','SUSPENDED','REJECTED') NOT NULL DEFAULT 'PENDING',
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `tax_id` (`tax_id`),
  KEY `idx_companies_status` (`status`),
  KEY `idx_companies_name` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `companies`
--

LOCK TABLES `companies` WRITE;
/*!40000 ALTER TABLE `companies` DISABLE KEYS */;
/*!40000 ALTER TABLE `companies` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `company_commission_settings`
--

DROP TABLE IF EXISTS `company_commission_settings`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `company_commission_settings` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `company_id` int(10) unsigned NOT NULL,
  `commission_type` enum('PERCENTAGE','FIXED') NOT NULL DEFAULT 'PERCENTAGE',
  `commission_value` decimal(10,2) NOT NULL DEFAULT 0.00,
  `effective_from` datetime NOT NULL DEFAULT current_timestamp(),
  `effective_until` datetime DEFAULT NULL,
  `status` enum('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_commission_settings_company` (`company_id`),
  KEY `idx_commission_settings_status` (`status`),
  KEY `idx_commission_settings_dates` (`effective_from`,`effective_until`),
  CONSTRAINT `fk_commission_settings_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `company_commission_settings`
--

LOCK TABLES `company_commission_settings` WRITE;
/*!40000 ALTER TABLE `company_commission_settings` DISABLE KEYS */;
/*!40000 ALTER TABLE `company_commission_settings` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `company_users`
--

DROP TABLE IF EXISTS `company_users`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `company_users` (
  `company_id` int(10) unsigned NOT NULL,
  `user_id` int(10) unsigned NOT NULL,
  `position` varchar(100) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`company_id`,`user_id`),
  KEY `fk_company_users_user` (`user_id`),
  CONSTRAINT `fk_company_users_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_company_users_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `company_users`
--

LOCK TABLES `company_users` WRITE;
/*!40000 ALTER TABLE `company_users` DISABLE KEYS */;
/*!40000 ALTER TABLE `company_users` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `coupon_usages`
--

DROP TABLE IF EXISTS `coupon_usages`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `coupon_usages` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `coupon_id` int(10) unsigned NOT NULL,
  `user_id` int(10) unsigned NOT NULL,
  `booking_id` int(10) unsigned NOT NULL,
  `discount_amount` decimal(10,2) NOT NULL,
  `used_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_coupon_booking` (`coupon_id`,`booking_id`),
  KEY `idx_coupon_usages_coupon` (`coupon_id`),
  KEY `idx_coupon_usages_user` (`user_id`),
  KEY `idx_coupon_usages_booking` (`booking_id`),
  CONSTRAINT `fk_coupon_usages_booking` FOREIGN KEY (`booking_id`) REFERENCES `bookings` (`id`) ON UPDATE CASCADE,
  CONSTRAINT `fk_coupon_usages_coupon` FOREIGN KEY (`coupon_id`) REFERENCES `coupons` (`id`) ON UPDATE CASCADE,
  CONSTRAINT `fk_coupon_usages_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `coupon_usages`
--

LOCK TABLES `coupon_usages` WRITE;
/*!40000 ALTER TABLE `coupon_usages` DISABLE KEYS */;
/*!40000 ALTER TABLE `coupon_usages` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `coupons`
--

DROP TABLE IF EXISTS `coupons`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `coupons` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `promotion_id` int(10) unsigned NOT NULL,
  `code` varchar(50) NOT NULL,
  `usage_limit` int(10) unsigned DEFAULT NULL,
  `usage_count` int(10) unsigned NOT NULL DEFAULT 0,
  `per_user_limit` int(10) unsigned DEFAULT NULL,
  `status` enum('ACTIVE','INACTIVE','EXPIRED') NOT NULL DEFAULT 'ACTIVE',
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `code` (`code`),
  KEY `idx_coupons_promotion` (`promotion_id`),
  KEY `idx_coupons_status` (`status`),
  KEY `idx_coupons_code` (`code`),
  CONSTRAINT `fk_coupons_promotion` FOREIGN KEY (`promotion_id`) REFERENCES `promotions` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `coupons`
--

LOCK TABLES `coupons` WRITE;
/*!40000 ALTER TABLE `coupons` DISABLE KEYS */;
/*!40000 ALTER TABLE `coupons` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `financial_transactions`
--

DROP TABLE IF EXISTS `financial_transactions`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `financial_transactions` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `company_id` int(10) unsigned DEFAULT NULL,
  `user_id` int(10) unsigned DEFAULT NULL,
  `booking_id` int(10) unsigned DEFAULT NULL,
  `payment_id` int(10) unsigned DEFAULT NULL,
  `type` enum('PAYMENT','REFUND','COMMISSION','PAYOUT','ADJUSTMENT') NOT NULL,
  `direction` enum('CREDIT','DEBIT') NOT NULL,
  `amount` decimal(12,2) NOT NULL,
  `currency` char(3) NOT NULL DEFAULT 'PEN',
  `description` varchar(500) DEFAULT NULL,
  `reference_code` varchar(100) DEFAULT NULL,
  `status` enum('PENDING','COMPLETED','FAILED','CANCELLED') NOT NULL DEFAULT 'PENDING',
  `transaction_date` datetime NOT NULL DEFAULT current_timestamp(),
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_financial_transactions_company` (`company_id`),
  KEY `idx_financial_transactions_user` (`user_id`),
  KEY `idx_financial_transactions_booking` (`booking_id`),
  KEY `idx_financial_transactions_payment` (`payment_id`),
  KEY `idx_financial_transactions_type` (`type`),
  KEY `idx_financial_transactions_status` (`status`),
  KEY `idx_financial_transactions_date` (`transaction_date`),
  KEY `idx_financial_transactions_reference` (`reference_code`),
  CONSTRAINT `fk_financial_transactions_booking` FOREIGN KEY (`booking_id`) REFERENCES `bookings` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_financial_transactions_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_financial_transactions_payment` FOREIGN KEY (`payment_id`) REFERENCES `payments` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_financial_transactions_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `financial_transactions`
--

LOCK TABLES `financial_transactions` WRITE;
/*!40000 ALTER TABLE `financial_transactions` DISABLE KEYS */;
/*!40000 ALTER TABLE `financial_transactions` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `locations`
--

DROP TABLE IF EXISTS `locations`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `locations` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `name` varchar(150) NOT NULL,
  `city` varchar(150) NOT NULL,
  `province` varchar(150) DEFAULT NULL,
  `department` varchar(150) DEFAULT NULL,
  `country_code` char(2) NOT NULL DEFAULT 'PE',
  `latitude` decimal(10,7) DEFAULT NULL,
  `longitude` decimal(10,7) DEFAULT NULL,
  `type` enum('CITY','TERMINAL','AGENCY','OTHER') NOT NULL DEFAULT 'CITY',
  `address` varchar(255) DEFAULT NULL,
  `status` enum('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_locations_city` (`city`),
  KEY `idx_locations_department` (`department`),
  KEY `idx_locations_status` (`status`),
  KEY `idx_locations_type` (`type`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `locations`
--

LOCK TABLES `locations` WRITE;
/*!40000 ALTER TABLE `locations` DISABLE KEYS */;
/*!40000 ALTER TABLE `locations` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `notification_templates`
--

DROP TABLE IF EXISTS `notification_templates`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `notification_templates` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `name` varchar(100) NOT NULL,
  `type` enum('EMAIL','PUSH','SMS','IN_APP') NOT NULL,
  `subject` varchar(255) DEFAULT NULL,
  `title` varchar(255) DEFAULT NULL,
  `body` text NOT NULL,
  `variables` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`variables`)),
  `status` enum('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `name` (`name`),
  KEY `idx_notification_templates_type` (`type`),
  KEY `idx_notification_templates_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `notification_templates`
--

LOCK TABLES `notification_templates` WRITE;
/*!40000 ALTER TABLE `notification_templates` DISABLE KEYS */;
/*!40000 ALTER TABLE `notification_templates` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `notifications`
--

DROP TABLE IF EXISTS `notifications`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `notifications` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `user_id` int(10) unsigned NOT NULL,
  `template_id` int(10) unsigned DEFAULT NULL,
  `type` enum('EMAIL','PUSH','SMS','IN_APP') NOT NULL DEFAULT 'IN_APP',
  `title` varchar(255) NOT NULL,
  `message` text NOT NULL,
  `data` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`data`)),
  `is_read` tinyint(1) NOT NULL DEFAULT 0,
  `read_at` datetime DEFAULT NULL,
  `sent_at` datetime DEFAULT NULL,
  `status` enum('PENDING','SENT','FAILED','READ') NOT NULL DEFAULT 'PENDING',
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_notifications_user` (`user_id`),
  KEY `idx_notifications_template` (`template_id`),
  KEY `idx_notifications_read` (`user_id`,`is_read`),
  KEY `idx_notifications_status` (`status`),
  KEY `idx_notifications_created_at` (`created_at`),
  CONSTRAINT `fk_notifications_template` FOREIGN KEY (`template_id`) REFERENCES `notification_templates` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_notifications_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `notifications`
--

LOCK TABLES `notifications` WRITE;
/*!40000 ALTER TABLE `notifications` DISABLE KEYS */;
/*!40000 ALTER TABLE `notifications` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `payments`
--

DROP TABLE IF EXISTS `payments`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `payments` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `booking_id` int(10) unsigned NOT NULL,
  `transaction_code` varchar(100) DEFAULT NULL,
  `amount` decimal(10,2) NOT NULL,
  `currency` char(3) NOT NULL DEFAULT 'PEN',
  `method` enum('CARD','YAPE','PLIN','TRANSFER','CASH','OTHER') NOT NULL,
  `status` enum('PENDING','PROCESSING','PAID','FAILED','CANCELLED','REFUNDED') NOT NULL DEFAULT 'PENDING',
  `provider` varchar(100) DEFAULT NULL,
  `provider_transaction_id` varchar(150) DEFAULT NULL,
  `payment_data` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`payment_data`)),
  `paid_at` datetime DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `transaction_code` (`transaction_code`),
  KEY `idx_payments_booking` (`booking_id`),
  KEY `idx_payments_status` (`status`),
  KEY `idx_payments_created_at` (`created_at`),
  KEY `idx_payments_provider_transaction` (`provider_transaction_id`),
  CONSTRAINT `fk_payments_booking` FOREIGN KEY (`booking_id`) REFERENCES `bookings` (`id`) ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `payments`
--

LOCK TABLES `payments` WRITE;
/*!40000 ALTER TABLE `payments` DISABLE KEYS */;
/*!40000 ALTER TABLE `payments` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `permissions`
--

DROP TABLE IF EXISTS `permissions`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `permissions` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `name` varchar(100) NOT NULL,
  `module` varchar(50) NOT NULL,
  `description` varchar(255) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `name` (`name`)
) ENGINE=InnoDB AUTO_INCREMENT=44 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `permissions`
--

LOCK TABLES `permissions` WRITE;
/*!40000 ALTER TABLE `permissions` DISABLE KEYS */;
INSERT INTO `permissions` VALUES (1,'users.view','users','Ver usuarios','2026-09-01 00:45:47'),(2,'users.create','users','Crear usuarios','2026-09-01 00:45:47'),(3,'users.update','users','Actualizar usuarios','2026-09-01 00:45:47'),(4,'users.delete','users','Eliminar usuarios','2026-09-01 00:45:47'),(5,'roles.view','roles','Ver roles','2026-09-01 00:45:47'),(6,'roles.create','roles','Crear roles','2026-09-01 00:45:47'),(7,'roles.update','roles','Actualizar roles','2026-09-01 00:45:47'),(8,'roles.delete','roles','Eliminar roles','2026-09-01 00:45:47'),(9,'companies.view','companies','Ver empresas','2026-09-01 00:45:47'),(10,'companies.create','companies','Crear empresas','2026-09-01 00:45:47'),(11,'companies.update','companies','Actualizar empresas','2026-09-01 00:45:47'),(12,'companies.delete','companies','Eliminar empresas','2026-09-01 00:45:47'),(13,'buses.view','buses','Ver buses','2026-09-01 00:45:47'),(14,'buses.create','buses','Crear buses','2026-09-01 00:45:47'),(15,'buses.update','buses','Actualizar buses','2026-09-01 00:45:47'),(16,'buses.delete','buses','Eliminar buses','2026-09-01 00:45:47'),(17,'routes.view','routes','Ver rutas','2026-09-01 00:45:47'),(18,'routes.create','routes','Crear rutas','2026-09-01 00:45:47'),(19,'routes.update','routes','Actualizar rutas','2026-09-01 00:45:47'),(20,'routes.delete','routes','Eliminar rutas','2026-09-01 00:45:47'),(21,'trips.view','trips','Ver viajes','2026-09-01 00:45:47'),(22,'trips.create','trips','Crear viajes','2026-09-01 00:45:47'),(23,'trips.update','trips','Actualizar viajes','2026-09-01 00:45:47'),(24,'trips.delete','trips','Eliminar viajes','2026-09-01 00:45:47'),(25,'bookings.view','bookings','Ver reservas','2026-09-01 00:45:47'),(26,'bookings.create','bookings','Crear reservas','2026-09-01 00:45:47'),(27,'bookings.update','bookings','Actualizar reservas','2026-09-01 00:45:47'),(28,'bookings.cancel','bookings','Cancelar reservas','2026-09-01 00:45:47'),(29,'payments.view','payments','Ver pagos','2026-09-01 00:45:47'),(30,'payments.create','payments','Registrar pagos','2026-09-01 00:45:47'),(31,'payments.refund','payments','Procesar reembolsos','2026-09-01 00:45:47'),(32,'promotions.view','promotions','Ver promociones','2026-09-01 00:45:47'),(33,'promotions.create','promotions','Crear promociones','2026-09-01 00:45:47'),(34,'promotions.update','promotions','Actualizar promociones','2026-09-01 00:45:47'),(35,'promotions.delete','promotions','Eliminar promociones','2026-09-01 00:45:47'),(36,'reviews.view','reviews','Ver reseñas','2026-09-01 00:45:47'),(37,'reviews.create','reviews','Crear reseñas','2026-09-01 00:45:47'),(38,'reviews.update','reviews','Actualizar reseñas','2026-09-01 00:45:47'),(39,'reviews.delete','reviews','Eliminar reseñas','2026-09-01 00:45:47'),(40,'reports.view','reports','Ver reportes','2026-09-01 00:45:47'),(41,'audit_logs.view','audit_logs','Ver registros de auditoría','2026-09-01 00:45:47'),(42,'settings.view','settings','Ver configuración','2026-09-01 00:45:47'),(43,'settings.update','settings','Modificar configuración','2026-09-01 00:45:47');
/*!40000 ALTER TABLE `permissions` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `promotions`
--

DROP TABLE IF EXISTS `promotions`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `promotions` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `company_id` int(10) unsigned DEFAULT NULL,
  `name` varchar(150) NOT NULL,
  `description` varchar(500) DEFAULT NULL,
  `discount_type` enum('PERCENTAGE','FIXED_AMOUNT') NOT NULL,
  `discount_value` decimal(10,2) NOT NULL,
  `minimum_amount` decimal(10,2) DEFAULT NULL,
  `maximum_discount` decimal(10,2) DEFAULT NULL,
  `start_at` datetime NOT NULL,
  `end_at` datetime NOT NULL,
  `usage_limit` int(10) unsigned DEFAULT NULL,
  `usage_count` int(10) unsigned NOT NULL DEFAULT 0,
  `status` enum('DRAFT','ACTIVE','INACTIVE','EXPIRED') NOT NULL DEFAULT 'DRAFT',
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_promotions_company` (`company_id`),
  KEY `idx_promotions_status` (`status`),
  KEY `idx_promotions_dates` (`start_at`,`end_at`),
  CONSTRAINT `fk_promotions_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `promotions`
--

LOCK TABLES `promotions` WRITE;
/*!40000 ALTER TABLE `promotions` DISABLE KEYS */;
/*!40000 ALTER TABLE `promotions` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `refunds`
--

DROP TABLE IF EXISTS `refunds`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `refunds` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `payment_id` int(10) unsigned NOT NULL,
  `booking_id` int(10) unsigned NOT NULL,
  `amount` decimal(10,2) NOT NULL,
  `reason` varchar(500) DEFAULT NULL,
  `status` enum('PENDING','PROCESSING','COMPLETED','FAILED','CANCELLED') NOT NULL DEFAULT 'PENDING',
  `provider_refund_id` varchar(150) DEFAULT NULL,
  `processed_at` datetime DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_refunds_payment` (`payment_id`),
  KEY `idx_refunds_booking` (`booking_id`),
  KEY `idx_refunds_status` (`status`),
  CONSTRAINT `fk_refunds_booking` FOREIGN KEY (`booking_id`) REFERENCES `bookings` (`id`) ON UPDATE CASCADE,
  CONSTRAINT `fk_refunds_payment` FOREIGN KEY (`payment_id`) REFERENCES `payments` (`id`) ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `refunds`
--

LOCK TABLES `refunds` WRITE;
/*!40000 ALTER TABLE `refunds` DISABLE KEYS */;
/*!40000 ALTER TABLE `refunds` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `review_responses`
--

DROP TABLE IF EXISTS `review_responses`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `review_responses` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `review_id` int(10) unsigned NOT NULL,
  `user_id` int(10) unsigned NOT NULL,
  `response` text NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_review_responses_review` (`review_id`),
  KEY `idx_review_responses_user` (`user_id`),
  CONSTRAINT `fk_review_responses_review` FOREIGN KEY (`review_id`) REFERENCES `reviews` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_review_responses_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `review_responses`
--

LOCK TABLES `review_responses` WRITE;
/*!40000 ALTER TABLE `review_responses` DISABLE KEYS */;
/*!40000 ALTER TABLE `review_responses` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `reviews`
--

DROP TABLE IF EXISTS `reviews`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `reviews` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `user_id` int(10) unsigned NOT NULL,
  `booking_id` int(10) unsigned NOT NULL,
  `trip_id` int(10) unsigned NOT NULL,
  `company_id` int(10) unsigned NOT NULL,
  `rating` tinyint(3) unsigned NOT NULL,
  `title` varchar(150) DEFAULT NULL,
  `comment` text DEFAULT NULL,
  `status` enum('PENDING','PUBLISHED','HIDDEN','REJECTED') NOT NULL DEFAULT 'PENDING',
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_review_booking_user` (`booking_id`,`user_id`),
  KEY `idx_reviews_user` (`user_id`),
  KEY `idx_reviews_booking` (`booking_id`),
  KEY `idx_reviews_trip` (`trip_id`),
  KEY `idx_reviews_company` (`company_id`),
  KEY `idx_reviews_rating` (`rating`),
  KEY `idx_reviews_status` (`status`),
  KEY `idx_reviews_created_at` (`created_at`),
  CONSTRAINT `fk_reviews_booking` FOREIGN KEY (`booking_id`) REFERENCES `bookings` (`id`) ON UPDATE CASCADE,
  CONSTRAINT `fk_reviews_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`) ON UPDATE CASCADE,
  CONSTRAINT `fk_reviews_trip` FOREIGN KEY (`trip_id`) REFERENCES `trips` (`id`) ON UPDATE CASCADE,
  CONSTRAINT `fk_reviews_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON UPDATE CASCADE,
  CONSTRAINT `chk_reviews_rating` CHECK (`rating` between 1 and 5)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `reviews`
--

LOCK TABLES `reviews` WRITE;
/*!40000 ALTER TABLE `reviews` DISABLE KEYS */;
/*!40000 ALTER TABLE `reviews` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `role_permissions`
--

DROP TABLE IF EXISTS `role_permissions`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `role_permissions` (
  `role_id` int(10) unsigned NOT NULL,
  `permission_id` int(10) unsigned NOT NULL,
  PRIMARY KEY (`role_id`,`permission_id`),
  KEY `fk_role_permissions_permission` (`permission_id`),
  CONSTRAINT `fk_role_permissions_permission` FOREIGN KEY (`permission_id`) REFERENCES `permissions` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_role_permissions_role` FOREIGN KEY (`role_id`) REFERENCES `roles` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `role_permissions`
--

LOCK TABLES `role_permissions` WRITE;
/*!40000 ALTER TABLE `role_permissions` DISABLE KEYS */;
INSERT INTO `role_permissions` VALUES (1,1),(1,2),(1,3),(1,4),(1,5),(1,6),(1,7),(1,8),(1,9),(1,10),(1,11),(1,12),(1,13),(1,14),(1,15),(1,16),(1,17),(1,18),(1,19),(1,20),(1,21),(1,22),(1,23),(1,24),(1,25),(1,26),(1,27),(1,28),(1,29),(1,30),(1,31),(1,32),(1,33),(1,34),(1,35),(1,36),(1,37),(1,38),(1,39),(1,40),(1,41),(1,42),(1,43),(2,1),(2,2),(2,3),(2,9),(2,10),(2,11),(2,13),(2,14),(2,15),(2,16),(2,17),(2,18),(2,19),(2,20),(2,21),(2,22),(2,23),(2,24),(2,25),(2,26),(2,27),(2,28),(2,29),(2,30),(2,32),(2,33),(2,34),(2,35),(2,36),(2,40),(3,1),(3,9),(3,13),(3,17),(3,21),(3,22),(3,23),(3,25),(3,26),(3,27),(3,28),(3,29),(3,32),(3,36),(3,40),(4,1),(4,3),(4,9),(4,13),(4,17),(4,21),(4,25),(4,26),(4,28),(4,29),(4,30),(4,32),(4,36),(4,37),(4,38);
/*!40000 ALTER TABLE `role_permissions` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `roles`
--

DROP TABLE IF EXISTS `roles`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `roles` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `name` varchar(50) NOT NULL,
  `description` varchar(255) DEFAULT NULL,
  `status` enum('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `name` (`name`)
) ENGINE=InnoDB AUTO_INCREMENT=5 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `roles`
--

LOCK TABLES `roles` WRITE;
/*!40000 ALTER TABLE `roles` DISABLE KEYS */;
INSERT INTO `roles` VALUES (1,'ADMIN','Administrador general del sistema','ACTIVE','2026-09-01 00:43:51','2026-09-01 00:43:51'),(2,'COMPANY_ADMIN','Administrador de una empresa de transporte','ACTIVE','2026-09-01 00:43:51','2026-09-01 00:43:51'),(3,'OPERATOR','Operador de empresa','ACTIVE','2026-09-01 00:43:51','2026-09-01 00:43:51'),(4,'CUSTOMER','Cliente del sistema','ACTIVE','2026-09-01 00:43:51','2026-09-01 00:43:51');
/*!40000 ALTER TABLE `roles` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `route_stops`
--

DROP TABLE IF EXISTS `route_stops`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `route_stops` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `route_id` int(10) unsigned NOT NULL,
  `location_id` int(10) unsigned NOT NULL,
  `stop_order` smallint(5) unsigned NOT NULL,
  `arrival_offset_minutes` int(10) unsigned DEFAULT NULL,
  `departure_offset_minutes` int(10) unsigned DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_route_stop_order` (`route_id`,`stop_order`),
  KEY `idx_route_stops_route` (`route_id`),
  KEY `idx_route_stops_location` (`location_id`),
  CONSTRAINT `fk_route_stops_location` FOREIGN KEY (`location_id`) REFERENCES `locations` (`id`) ON UPDATE CASCADE,
  CONSTRAINT `fk_route_stops_route` FOREIGN KEY (`route_id`) REFERENCES `routes` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `route_stops`
--

LOCK TABLES `route_stops` WRITE;
/*!40000 ALTER TABLE `route_stops` DISABLE KEYS */;
/*!40000 ALTER TABLE `route_stops` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `routes`
--

DROP TABLE IF EXISTS `routes`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `routes` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `company_id` int(10) unsigned NOT NULL,
  `origin_location_id` int(10) unsigned NOT NULL,
  `destination_location_id` int(10) unsigned NOT NULL,
  `name` varchar(200) DEFAULT NULL,
  `distance_km` decimal(10,2) DEFAULT NULL,
  `estimated_duration_minutes` int(10) unsigned DEFAULT NULL,
  `status` enum('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_routes_company` (`company_id`),
  KEY `idx_routes_origin` (`origin_location_id`),
  KEY `idx_routes_destination` (`destination_location_id`),
  KEY `idx_routes_status` (`status`),
  CONSTRAINT `fk_routes_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_routes_destination` FOREIGN KEY (`destination_location_id`) REFERENCES `locations` (`id`) ON UPDATE CASCADE,
  CONSTRAINT `fk_routes_origin` FOREIGN KEY (`origin_location_id`) REFERENCES `locations` (`id`) ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `routes`
--

LOCK TABLES `routes` WRITE;
/*!40000 ALTER TABLE `routes` DISABLE KEYS */;
/*!40000 ALTER TABLE `routes` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `seat_types`
--

DROP TABLE IF EXISTS `seat_types`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `seat_types` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `name` varchar(50) NOT NULL,
  `description` varchar(255) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `name` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `seat_types`
--

LOCK TABLES `seat_types` WRITE;
/*!40000 ALTER TABLE `seat_types` DISABLE KEYS */;
/*!40000 ALTER TABLE `seat_types` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `seats`
--

DROP TABLE IF EXISTS `seats`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `seats` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `bus_id` int(10) unsigned NOT NULL,
  `seat_type_id` int(10) unsigned DEFAULT NULL,
  `seat_number` varchar(10) NOT NULL,
  `row_number` smallint(5) unsigned DEFAULT NULL,
  `column_number` smallint(5) unsigned DEFAULT NULL,
  `is_window` tinyint(1) NOT NULL DEFAULT 0,
  `is_aisle` tinyint(1) NOT NULL DEFAULT 0,
  `status` enum('AVAILABLE','INACTIVE') NOT NULL DEFAULT 'AVAILABLE',
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_bus_seat_number` (`bus_id`,`seat_number`),
  KEY `idx_seats_bus` (`bus_id`),
  KEY `idx_seats_type` (`seat_type_id`),
  KEY `idx_seats_status` (`status`),
  CONSTRAINT `fk_seats_bus` FOREIGN KEY (`bus_id`) REFERENCES `buses` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_seats_type` FOREIGN KEY (`seat_type_id`) REFERENCES `seat_types` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `seats`
--

LOCK TABLES `seats` WRITE;
/*!40000 ALTER TABLE `seats` DISABLE KEYS */;
/*!40000 ALTER TABLE `seats` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `settlement_items`
--

DROP TABLE IF EXISTS `settlement_items`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `settlement_items` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `settlement_id` int(10) unsigned NOT NULL,
  `booking_id` int(10) unsigned DEFAULT NULL,
  `financial_transaction_id` int(10) unsigned DEFAULT NULL,
  `type` enum('SALE','COMMISSION','REFUND','ADJUSTMENT') NOT NULL,
  `amount` decimal(12,2) NOT NULL,
  `description` varchar(500) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_settlement_items_settlement` (`settlement_id`),
  KEY `idx_settlement_items_booking` (`booking_id`),
  KEY `idx_settlement_items_transaction` (`financial_transaction_id`),
  KEY `idx_settlement_items_type` (`type`),
  CONSTRAINT `fk_settlement_items_booking` FOREIGN KEY (`booking_id`) REFERENCES `bookings` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_settlement_items_settlement` FOREIGN KEY (`settlement_id`) REFERENCES `settlements` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_settlement_items_transaction` FOREIGN KEY (`financial_transaction_id`) REFERENCES `financial_transactions` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `settlement_items`
--

LOCK TABLES `settlement_items` WRITE;
/*!40000 ALTER TABLE `settlement_items` DISABLE KEYS */;
/*!40000 ALTER TABLE `settlement_items` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `settlements`
--

DROP TABLE IF EXISTS `settlements`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `settlements` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `company_id` int(10) unsigned NOT NULL,
  `settlement_code` varchar(50) NOT NULL,
  `period_start` date NOT NULL,
  `period_end` date NOT NULL,
  `gross_amount` decimal(12,2) NOT NULL DEFAULT 0.00,
  `commission_amount` decimal(12,2) NOT NULL DEFAULT 0.00,
  `refund_amount` decimal(12,2) NOT NULL DEFAULT 0.00,
  `adjustment_amount` decimal(12,2) NOT NULL DEFAULT 0.00,
  `net_amount` decimal(12,2) NOT NULL DEFAULT 0.00,
  `currency` char(3) NOT NULL DEFAULT 'PEN',
  `status` enum('PENDING','PROCESSING','PAID','FAILED','CANCELLED') NOT NULL DEFAULT 'PENDING',
  `payment_reference` varchar(150) DEFAULT NULL,
  `paid_at` datetime DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `settlement_code` (`settlement_code`),
  KEY `idx_settlements_company` (`company_id`),
  KEY `idx_settlements_status` (`status`),
  KEY `idx_settlements_period` (`period_start`,`period_end`),
  KEY `idx_settlements_paid_at` (`paid_at`),
  CONSTRAINT `fk_settlements_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`) ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `settlements`
--

LOCK TABLES `settlements` WRITE;
/*!40000 ALTER TABLE `settlements` DISABLE KEYS */;
/*!40000 ALTER TABLE `settlements` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `support_messages`
--

DROP TABLE IF EXISTS `support_messages`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `support_messages` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `ticket_id` int(10) unsigned NOT NULL,
  `user_id` int(10) unsigned NOT NULL,
  `message` text NOT NULL,
  `attachments` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`attachments`)),
  `is_internal` tinyint(1) NOT NULL DEFAULT 0,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_support_messages_ticket` (`ticket_id`),
  KEY `idx_support_messages_user` (`user_id`),
  KEY `idx_support_messages_created_at` (`created_at`),
  CONSTRAINT `fk_support_messages_ticket` FOREIGN KEY (`ticket_id`) REFERENCES `support_tickets` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_support_messages_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `support_messages`
--

LOCK TABLES `support_messages` WRITE;
/*!40000 ALTER TABLE `support_messages` DISABLE KEYS */;
/*!40000 ALTER TABLE `support_messages` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `support_tickets`
--

DROP TABLE IF EXISTS `support_tickets`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `support_tickets` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `ticket_code` varchar(30) NOT NULL,
  `user_id` int(10) unsigned NOT NULL,
  `booking_id` int(10) unsigned DEFAULT NULL,
  `company_id` int(10) unsigned DEFAULT NULL,
  `subject` varchar(255) NOT NULL,
  `category` enum('BOOKING','PAYMENT','REFUND','TRAVEL','ACCOUNT','TECHNICAL','OTHER') NOT NULL DEFAULT 'OTHER',
  `priority` enum('LOW','MEDIUM','HIGH','URGENT') NOT NULL DEFAULT 'MEDIUM',
  `status` enum('OPEN','IN_PROGRESS','WAITING_USER','RESOLVED','CLOSED') NOT NULL DEFAULT 'OPEN',
  `assigned_to` int(10) unsigned DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `resolved_at` datetime DEFAULT NULL,
  `closed_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `ticket_code` (`ticket_code`),
  KEY `idx_support_tickets_user` (`user_id`),
  KEY `idx_support_tickets_booking` (`booking_id`),
  KEY `idx_support_tickets_company` (`company_id`),
  KEY `idx_support_tickets_assigned` (`assigned_to`),
  KEY `idx_support_tickets_status` (`status`),
  KEY `idx_support_tickets_priority` (`priority`),
  KEY `idx_support_tickets_created_at` (`created_at`),
  CONSTRAINT `fk_support_tickets_assigned` FOREIGN KEY (`assigned_to`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_support_tickets_booking` FOREIGN KEY (`booking_id`) REFERENCES `bookings` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_support_tickets_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_support_tickets_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `support_tickets`
--

LOCK TABLES `support_tickets` WRITE;
/*!40000 ALTER TABLE `support_tickets` DISABLE KEYS */;
/*!40000 ALTER TABLE `support_tickets` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `system_settings`
--

DROP TABLE IF EXISTS `system_settings`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `system_settings` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `setting_key` varchar(150) NOT NULL,
  `setting_value` text DEFAULT NULL,
  `setting_type` enum('STRING','INTEGER','DECIMAL','BOOLEAN','JSON') NOT NULL DEFAULT 'STRING',
  `description` varchar(500) DEFAULT NULL,
  `is_public` tinyint(1) NOT NULL DEFAULT 0,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `setting_key` (`setting_key`),
  KEY `idx_system_settings_public` (`is_public`),
  KEY `idx_system_settings_type` (`setting_type`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `system_settings`
--

LOCK TABLES `system_settings` WRITE;
/*!40000 ALTER TABLE `system_settings` DISABLE KEYS */;
/*!40000 ALTER TABLE `system_settings` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `trips`
--

DROP TABLE IF EXISTS `trips`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `trips` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `route_id` int(10) unsigned NOT NULL,
  `bus_id` int(10) unsigned NOT NULL,
  `departure_datetime` datetime NOT NULL,
  `arrival_datetime` datetime DEFAULT NULL,
  `base_price` decimal(10,2) NOT NULL,
  `available_seats` smallint(5) unsigned DEFAULT NULL,
  `status` enum('SCHEDULED','BOARDING','IN_PROGRESS','COMPLETED','CANCELLED','DELAYED') NOT NULL DEFAULT 'SCHEDULED',
  `boarding_notes` varchar(500) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_trips_route` (`route_id`),
  KEY `idx_trips_bus` (`bus_id`),
  KEY `idx_trips_departure` (`departure_datetime`),
  KEY `idx_trips_status` (`status`),
  KEY `idx_trips_search` (`route_id`,`departure_datetime`,`status`),
  CONSTRAINT `fk_trips_bus` FOREIGN KEY (`bus_id`) REFERENCES `buses` (`id`) ON UPDATE CASCADE,
  CONSTRAINT `fk_trips_route` FOREIGN KEY (`route_id`) REFERENCES `routes` (`id`) ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `trips`
--

LOCK TABLES `trips` WRITE;
/*!40000 ALTER TABLE `trips` DISABLE KEYS */;
/*!40000 ALTER TABLE `trips` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `users`
--

DROP TABLE IF EXISTS `users`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `users` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `role_id` int(10) unsigned NOT NULL,
  `first_name` varchar(100) NOT NULL,
  `last_name` varchar(100) NOT NULL,
  `email` varchar(150) NOT NULL,
  `phone` varchar(30) DEFAULT NULL,
  `password_hash` varchar(255) NOT NULL,
  `avatar_url` varchar(500) DEFAULT NULL,
  `status` enum('ACTIVE','INACTIVE','SUSPENDED','PENDING') NOT NULL DEFAULT 'PENDING',
  `email_verified_at` timestamp NULL DEFAULT NULL,
  `last_login_at` timestamp NULL DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `email` (`email`),
  KEY `idx_users_role` (`role_id`),
  KEY `idx_users_status` (`status`),
  KEY `idx_users_created_at` (`created_at`),
  CONSTRAINT `fk_users_role` FOREIGN KEY (`role_id`) REFERENCES `roles` (`id`) ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `users`
--

LOCK TABLES `users` WRITE;
/*!40000 ALTER TABLE `users` DISABLE KEYS */;
/*!40000 ALTER TABLE `users` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Dumping events for database 'busperu'
--

--
-- Dumping routines for database 'busperu'
--
/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;

/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;

-- Dump completed on 2026-08-31 20:23:45
