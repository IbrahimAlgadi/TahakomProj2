--
-- PostgreSQL database dump
--

-- Dumped from database version 12.3
-- Dumped by pg_dump version 12.3

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: tahakom_transfer; Type: DATABASE; Schema: -; Owner: postgres
--

CREATE DATABASE tahakom_transfer WITH TEMPLATE = template0 ENCODING = 'UTF8' LC_COLLATE = 'English_United States.1252' LC_CTYPE = 'English_United States.1252';


ALTER DATABASE tahakom_transfer OWNER TO postgres;

\connect tahakom_transfer

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: get_readable_uptime(integer); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.get_readable_uptime(minutes integer) RETURNS text
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF minutes IS NULL OR minutes = 0 THEN
        RETURN '0 minutes';
    END IF;
    
    IF minutes < 60 THEN
        RETURN minutes || ' minutes';
    ELSIF minutes < 1440 THEN
        RETURN (minutes / 60) || 'h ' || (minutes % 60) || 'm';
    ELSE
        RETURN (minutes / 1440) || 'd ' || ((minutes % 1440) / 60) || 'h ' || (minutes % 60) || 'm';
    END IF;
END;
$$;


ALTER FUNCTION public.get_readable_uptime(minutes integer) OWNER TO postgres;

--
-- Name: update_transfer_queue_job_updated_at(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.update_transfer_queue_job_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$;


ALTER FUNCTION public.update_transfer_queue_job_updated_at() OWNER TO postgres;

--
-- Name: update_transfer_queue_updated_at(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.update_transfer_queue_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$;


ALTER FUNCTION public.update_transfer_queue_updated_at() OWNER TO postgres;

--
-- Name: update_updated_at(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.update_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
            BEGIN
                NEW.updated_at = NOW();
                RETURN NEW;
            END;
            $$;


ALTER FUNCTION public.update_updated_at() OWNER TO postgres;

--
-- Name: update_updated_at_column(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.update_updated_at_column() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$;


ALTER FUNCTION public.update_updated_at_column() OWNER TO postgres;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: auto_transfer_device; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.auto_transfer_device (
    id integer NOT NULL,
    usb_path text NOT NULL,
    status text NOT NULL
);


ALTER TABLE public.auto_transfer_device OWNER TO postgres;

--
-- Name: auto_transfer_device_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.auto_transfer_device_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.auto_transfer_device_id_seq OWNER TO postgres;

--
-- Name: auto_transfer_device_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.auto_transfer_device_id_seq OWNED BY public.auto_transfer_device.id;


--
-- Name: auto_transfer_job; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.auto_transfer_job (
    id integer NOT NULL,
    auto_transfer_device_id integer,
    date date,
    "time" time without time zone,
    status text,
    size_transferred integer
);


ALTER TABLE public.auto_transfer_job OWNER TO postgres;

--
-- Name: auto_transfer_job_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.auto_transfer_job_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.auto_transfer_job_id_seq OWNER TO postgres;

--
-- Name: auto_transfer_job_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.auto_transfer_job_id_seq OWNED BY public.auto_transfer_job.id;


--
-- Name: device_connections; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.device_connections (
    id integer NOT NULL,
    drive_letter character varying(2) NOT NULL,
    label text,
    total_space numeric(10,2),
    used_space numeric(10,2),
    remaining_space numeric(10,2),
    used_percentage numeric(5,2),
    filesystem_type text,
    is_read_write boolean,
    connected_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    disconnected_at timestamp without time zone,
    status text DEFAULT 'connected'::text,
    last_updated timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    current_uptime_minutes integer DEFAULT 0,
    total_uptime_minutes integer DEFAULT 0
);


ALTER TABLE public.device_connections OWNER TO postgres;

--
-- Name: device_connections_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.device_connections_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.device_connections_id_seq OWNER TO postgres;

--
-- Name: device_connections_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.device_connections_id_seq OWNED BY public.device_connections.id;


--
-- Name: files; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.files (
    id integer NOT NULL,
    tid text,
    file_path text,
    file_size integer,
    file_name text,
    site_id text,
    date_folder text,
    time_folder text,
    plate_num character varying(255),
    cam_id integer,
    deleted boolean DEFAULT false,
    is_auto_transferred boolean DEFAULT false,
    is_ftp_transferred boolean DEFAULT false,
    image_export_done_date_time timestamp without time zone,
    export_retry_count integer DEFAULT 0,
    export_retry_log_object jsonb DEFAULT '[]'::jsonb,
    deleted_date_time timestamp without time zone,
    export_params jsonb,
    date date,
    "time" time without time zone,
    ts timestamp without time zone GENERATED ALWAYS AS ((date + "time")) STORED,
    pending_deletion boolean DEFAULT false,
    updated_at timestamp without time zone DEFAULT now()
);


ALTER TABLE public.files OWNER TO postgres;

--
-- Name: files_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.files_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.files_id_seq OWNER TO postgres;

--
-- Name: files_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.files_id_seq OWNED BY public.files.id;


--
-- Name: ftp_image_transfer_queue; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.ftp_image_transfer_queue (
    id integer NOT NULL,
    file_id integer NOT NULL,
    file_path text NOT NULL,
    file_size bigint NOT NULL,
    file_type character varying(20) NOT NULL,
    file_origin character varying(20) NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    job_id integer NOT NULL,
    retry_count integer DEFAULT 0,
    max_retries integer DEFAULT 3,
    ftp_remote_path text,
    ftp_server_host text,
    ftp_upload_time timestamp without time zone,
    error_message text,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    transferred_at timestamp without time zone,
    CONSTRAINT ftp_image_transfer_queue_file_origin_check CHECK (((file_origin)::text = ANY (ARRAY[('auto'::character varying)::text, ('manual'::character varying)::text]))),
    CONSTRAINT ftp_image_transfer_queue_file_type_check CHECK (((file_type)::text = 'image'::text)),
    CONSTRAINT ftp_image_transfer_queue_status_check CHECK (((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('transferred'::character varying)::text, ('failed'::character varying)::text])))
);


ALTER TABLE public.ftp_image_transfer_queue OWNER TO postgres;

--
-- Name: ftp_image_transfer_queue_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.ftp_image_transfer_queue_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.ftp_image_transfer_queue_id_seq OWNER TO postgres;

--
-- Name: ftp_image_transfer_queue_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.ftp_image_transfer_queue_id_seq OWNED BY public.ftp_image_transfer_queue.id;


--
-- Name: ftp_image_transfer_queue_job; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.ftp_image_transfer_queue_job (
    id integer NOT NULL,
    batch_id text NOT NULL,
    batch_origin text DEFAULT 'auto_ftp'::text,
    status text DEFAULT 'created'::text,
    total_files integer DEFAULT 0,
    total_size bigint DEFAULT 0,
    transferred_files integer DEFAULT 0,
    transferred_size bigint DEFAULT 0,
    ftp_server_config jsonb,
    error_message text,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    started_at timestamp without time zone,
    completed_at timestamp without time zone
);


ALTER TABLE public.ftp_image_transfer_queue_job OWNER TO postgres;

--
-- Name: ftp_image_transfer_queue_job_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.ftp_image_transfer_queue_job_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.ftp_image_transfer_queue_job_id_seq OWNER TO postgres;

--
-- Name: ftp_image_transfer_queue_job_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.ftp_image_transfer_queue_job_id_seq OWNED BY public.ftp_image_transfer_queue_job.id;


--
-- Name: ftp_video_converted_buffer; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.ftp_video_converted_buffer (
    id integer NOT NULL,
    source_file_id integer NOT NULL,
    converted_file_path text,
    converted_file_name text,
    converted_file_size bigint DEFAULT 0,
    camera_id integer NOT NULL,
    site_id text,
    recording_date date,
    recording_time time without time zone,
    precise_time text,
    timezone_offset integer,
    group_key text,
    job_id integer NOT NULL,
    group_interval_start integer,
    group_interval_end integer,
    status text DEFAULT 'pending'::text,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


ALTER TABLE public.ftp_video_converted_buffer OWNER TO postgres;

--
-- Name: ftp_video_converted_buffer_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.ftp_video_converted_buffer_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.ftp_video_converted_buffer_id_seq OWNER TO postgres;

--
-- Name: ftp_video_converted_buffer_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.ftp_video_converted_buffer_id_seq OWNED BY public.ftp_video_converted_buffer.id;


--
-- Name: ftp_video_transfer_queue; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.ftp_video_transfer_queue (
    id integer NOT NULL,
    video_file_path text NOT NULL,
    video_file_name text NOT NULL,
    video_file_size bigint NOT NULL,
    camera_id integer NOT NULL,
    site_id text,
    recording_date date,
    interval_start_minutes integer,
    interval_end_minutes integer,
    source_files_count integer DEFAULT 0,
    source_files_size bigint DEFAULT 0,
    source_file_ids integer[],
    status text DEFAULT 'pending'::text,
    job_id integer,
    transfer_progress integer DEFAULT 0,
    retry_count integer DEFAULT 0,
    max_retries integer DEFAULT 3,
    ftp_remote_path text,
    ftp_server_host text,
    ftp_upload_time timestamp without time zone,
    error_message text,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    transferred_at timestamp without time zone
);


ALTER TABLE public.ftp_video_transfer_queue OWNER TO postgres;

--
-- Name: ftp_video_transfer_queue_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.ftp_video_transfer_queue_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.ftp_video_transfer_queue_id_seq OWNER TO postgres;

--
-- Name: ftp_video_transfer_queue_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.ftp_video_transfer_queue_id_seq OWNED BY public.ftp_video_transfer_queue.id;


--
-- Name: ftp_video_transfer_queue_job; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.ftp_video_transfer_queue_job (
    id integer NOT NULL,
    batch_id text NOT NULL,
    batch_origin text DEFAULT 'auto_ftp_video'::text,
    status text DEFAULT 'created'::text,
    expected_cameras text[],
    processed_cameras text[] DEFAULT '{}'::text[],
    current_camera_id integer,
    total_videos integer DEFAULT 0,
    total_size bigint DEFAULT 0,
    transferred_videos integer DEFAULT 0,
    transferred_size bigint DEFAULT 0,
    interval_duration_minutes integer DEFAULT 5,
    site_id text,
    ftp_server_config jsonb,
    error_message text,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    started_at timestamp without time zone,
    completed_at timestamp without time zone
);


ALTER TABLE public.ftp_video_transfer_queue_job OWNER TO postgres;

--
-- Name: ftp_video_transfer_queue_job_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.ftp_video_transfer_queue_job_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.ftp_video_transfer_queue_job_id_seq OWNER TO postgres;

--
-- Name: ftp_video_transfer_queue_job_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.ftp_video_transfer_queue_job_id_seq OWNED BY public.ftp_video_transfer_queue_job.id;


--
-- Name: iss_media_files; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.iss_media_files (
    id integer NOT NULL,
    file_path text NOT NULL,
    file_name text NOT NULL,
    file_size bigint NOT NULL,
    camera_id integer NOT NULL,
    site_id text,
    recording_date date NOT NULL,
    recording_time time without time zone NOT NULL,
    timezone_offset text,
    precise_time time without time zone NOT NULL,
    is_auto_transferred boolean DEFAULT false,
    is_ftp_transferred boolean DEFAULT false,
    deleted boolean DEFAULT false,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


ALTER TABLE public.iss_media_files OWNER TO postgres;

--
-- Name: iss_media_files_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.iss_media_files_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.iss_media_files_id_seq OWNER TO postgres;

--
-- Name: iss_media_files_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.iss_media_files_id_seq OWNED BY public.iss_media_files.id;


--
-- Name: transfer_job; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.transfer_job (
    id integer NOT NULL,
    start_date date,
    start_time time without time zone,
    end_date date,
    end_time time without time zone,
    car_plate text,
    usb_path text,
    status text,
    date date,
    "time" time without time zone
);


ALTER TABLE public.transfer_job OWNER TO postgres;

--
-- Name: transfer_job_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.transfer_job_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.transfer_job_id_seq OWNER TO postgres;

--
-- Name: transfer_job_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.transfer_job_id_seq OWNED BY public.transfer_job.id;


--
-- Name: transfer_job_log; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.transfer_job_log (
    id integer NOT NULL,
    file_id integer NOT NULL,
    transfer_job_id integer NOT NULL,
    transferred boolean DEFAULT false
);


ALTER TABLE public.transfer_job_log OWNER TO postgres;

--
-- Name: transfer_job_log_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.transfer_job_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.transfer_job_log_id_seq OWNER TO postgres;

--
-- Name: transfer_job_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.transfer_job_log_id_seq OWNED BY public.transfer_job_log.id;


--
-- Name: transfer_queue; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.transfer_queue (
    id integer NOT NULL,
    file_id integer NOT NULL,
    file_path text NOT NULL,
    file_size bigint NOT NULL,
    destination_path text DEFAULT ''::text NOT NULL,
    usb_path text DEFAULT ''::text NOT NULL,
    file_type character varying(20) NOT NULL,
    file_origin character varying(20) NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    job_id integer NOT NULL,
    retry_count integer DEFAULT 0,
    max_retries integer DEFAULT 3,
    error_message text,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    transferred_at timestamp without time zone,
    CONSTRAINT transfer_queue_file_origin_check CHECK (((file_origin)::text = ANY (ARRAY[('auto'::character varying)::text, ('manual'::character varying)::text]))),
    CONSTRAINT transfer_queue_file_type_check CHECK (((file_type)::text = 'image'::text)),
    CONSTRAINT transfer_queue_status_check CHECK (((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('transferred'::character varying)::text, ('failed'::character varying)::text])))
);


ALTER TABLE public.transfer_queue OWNER TO postgres;

--
-- Name: transfer_queue_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.transfer_queue_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.transfer_queue_id_seq OWNER TO postgres;

--
-- Name: transfer_queue_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.transfer_queue_id_seq OWNED BY public.transfer_queue.id;


--
-- Name: transfer_queue_job; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.transfer_queue_job (
    id integer NOT NULL,
    batch_id uuid NOT NULL,
    batch_origin character varying(20) NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    total_files integer DEFAULT 0,
    total_size bigint DEFAULT 0,
    transferred_files integer DEFAULT 0,
    transferred_size bigint DEFAULT 0,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    started_at timestamp without time zone,
    completed_at timestamp without time zone,
    error_message text,
    CONSTRAINT transfer_queue_job_batch_origin_check CHECK (((batch_origin)::text = ANY (ARRAY[('auto'::character varying)::text, ('manual'::character varying)::text]))),
    CONSTRAINT transfer_queue_job_status_check CHECK (((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('transferring'::character varying)::text, ('paused'::character varying)::text, ('transferred'::character varying)::text, ('failed'::character varying)::text])))
);


ALTER TABLE public.transfer_queue_job OWNER TO postgres;

--
-- Name: transfer_queue_job_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.transfer_queue_job_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.transfer_queue_job_id_seq OWNER TO postgres;

--
-- Name: transfer_queue_job_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.transfer_queue_job_id_seq OWNED BY public.transfer_queue_job.id;


--
-- Name: video_converted_buffer; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.video_converted_buffer (
    id integer NOT NULL,
    source_file_id integer NOT NULL,
    converted_file_path text,
    converted_file_name text,
    converted_file_size bigint DEFAULT 0,
    camera_id integer NOT NULL,
    site_id text,
    recording_date date,
    recording_time time without time zone,
    precise_time text,
    timezone_offset integer,
    group_key text,
    job_id integer NOT NULL,
    group_interval_start integer,
    group_interval_end integer,
    status text DEFAULT 'pending'::text,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


ALTER TABLE public.video_converted_buffer OWNER TO postgres;

--
-- Name: video_converted_buffer_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.video_converted_buffer_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.video_converted_buffer_id_seq OWNER TO postgres;

--
-- Name: video_converted_buffer_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.video_converted_buffer_id_seq OWNED BY public.video_converted_buffer.id;


--
-- Name: video_transfer_queue; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.video_transfer_queue (
    id integer NOT NULL,
    video_file_path text NOT NULL,
    video_file_name text NOT NULL,
    video_file_size bigint NOT NULL,
    camera_id integer NOT NULL,
    site_id text,
    recording_date date,
    interval_start_minutes integer,
    interval_end_minutes integer,
    source_files_count integer DEFAULT 0,
    source_files_size bigint DEFAULT 0,
    source_file_ids integer[],
    status text DEFAULT 'pending'::text,
    job_id integer,
    transfer_progress integer DEFAULT 0,
    retry_count integer DEFAULT 0,
    max_retries integer DEFAULT 3,
    destination_path text,
    usb_path text,
    error_message text,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    transferred_at timestamp without time zone
);


ALTER TABLE public.video_transfer_queue OWNER TO postgres;

--
-- Name: video_transfer_queue_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.video_transfer_queue_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.video_transfer_queue_id_seq OWNER TO postgres;

--
-- Name: video_transfer_queue_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.video_transfer_queue_id_seq OWNED BY public.video_transfer_queue.id;


--
-- Name: video_transfer_queue_job; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.video_transfer_queue_job (
    id integer NOT NULL,
    batch_id text NOT NULL,
    batch_origin text DEFAULT 'auto_video'::text,
    status text DEFAULT 'created'::text,
    expected_cameras text[],
    processed_cameras text[] DEFAULT '{}'::text[],
    current_camera_id integer,
    total_videos integer DEFAULT 0,
    total_size bigint DEFAULT 0,
    transferred_videos integer DEFAULT 0,
    transferred_size bigint DEFAULT 0,
    interval_duration_minutes integer DEFAULT 5,
    site_id text,
    error_message text,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    started_at timestamp without time zone,
    completed_at timestamp without time zone
);


ALTER TABLE public.video_transfer_queue_job OWNER TO postgres;

--
-- Name: video_transfer_queue_job_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.video_transfer_queue_job_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.video_transfer_queue_job_id_seq OWNER TO postgres;

--
-- Name: video_transfer_queue_job_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.video_transfer_queue_job_id_seq OWNED BY public.video_transfer_queue_job.id;


--
-- Name: auto_transfer_device id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.auto_transfer_device ALTER COLUMN id SET DEFAULT nextval('public.auto_transfer_device_id_seq'::regclass);


--
-- Name: auto_transfer_job id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.auto_transfer_job ALTER COLUMN id SET DEFAULT nextval('public.auto_transfer_job_id_seq'::regclass);


--
-- Name: device_connections id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.device_connections ALTER COLUMN id SET DEFAULT nextval('public.device_connections_id_seq'::regclass);


--
-- Name: files id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.files ALTER COLUMN id SET DEFAULT nextval('public.files_id_seq'::regclass);


--
-- Name: ftp_image_transfer_queue id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.ftp_image_transfer_queue ALTER COLUMN id SET DEFAULT nextval('public.ftp_image_transfer_queue_id_seq'::regclass);


--
-- Name: ftp_image_transfer_queue_job id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.ftp_image_transfer_queue_job ALTER COLUMN id SET DEFAULT nextval('public.ftp_image_transfer_queue_job_id_seq'::regclass);


--
-- Name: ftp_video_converted_buffer id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.ftp_video_converted_buffer ALTER COLUMN id SET DEFAULT nextval('public.ftp_video_converted_buffer_id_seq'::regclass);


--
-- Name: ftp_video_transfer_queue id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.ftp_video_transfer_queue ALTER COLUMN id SET DEFAULT nextval('public.ftp_video_transfer_queue_id_seq'::regclass);


--
-- Name: ftp_video_transfer_queue_job id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.ftp_video_transfer_queue_job ALTER COLUMN id SET DEFAULT nextval('public.ftp_video_transfer_queue_job_id_seq'::regclass);


--
-- Name: iss_media_files id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.iss_media_files ALTER COLUMN id SET DEFAULT nextval('public.iss_media_files_id_seq'::regclass);


--
-- Name: transfer_job id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.transfer_job ALTER COLUMN id SET DEFAULT nextval('public.transfer_job_id_seq'::regclass);


--
-- Name: transfer_job_log id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.transfer_job_log ALTER COLUMN id SET DEFAULT nextval('public.transfer_job_log_id_seq'::regclass);


--
-- Name: transfer_queue id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.transfer_queue ALTER COLUMN id SET DEFAULT nextval('public.transfer_queue_id_seq'::regclass);


--
-- Name: transfer_queue_job id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.transfer_queue_job ALTER COLUMN id SET DEFAULT nextval('public.transfer_queue_job_id_seq'::regclass);


--
-- Name: video_converted_buffer id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.video_converted_buffer ALTER COLUMN id SET DEFAULT nextval('public.video_converted_buffer_id_seq'::regclass);


--
-- Name: video_transfer_queue id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.video_transfer_queue ALTER COLUMN id SET DEFAULT nextval('public.video_transfer_queue_id_seq'::regclass);


--
-- Name: video_transfer_queue_job id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.video_transfer_queue_job ALTER COLUMN id SET DEFAULT nextval('public.video_transfer_queue_job_id_seq'::regclass);


--
-- Name: auto_transfer_device auto_transfer_device_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.auto_transfer_device
    ADD CONSTRAINT auto_transfer_device_pkey PRIMARY KEY (id);


--
-- Name: auto_transfer_job auto_transfer_job_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.auto_transfer_job
    ADD CONSTRAINT auto_transfer_job_pkey PRIMARY KEY (id);


--
-- Name: device_connections device_connections_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.device_connections
    ADD CONSTRAINT device_connections_pkey PRIMARY KEY (id);


--
-- Name: files files_file_path_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.files
    ADD CONSTRAINT files_file_path_key UNIQUE (file_path);


--
-- Name: files files_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.files
    ADD CONSTRAINT files_pkey PRIMARY KEY (id);


--
-- Name: ftp_image_transfer_queue_job ftp_image_transfer_queue_job_batch_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.ftp_image_transfer_queue_job
    ADD CONSTRAINT ftp_image_transfer_queue_job_batch_id_key UNIQUE (batch_id);


--
-- Name: ftp_image_transfer_queue_job ftp_image_transfer_queue_job_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.ftp_image_transfer_queue_job
    ADD CONSTRAINT ftp_image_transfer_queue_job_pkey PRIMARY KEY (id);


--
-- Name: ftp_image_transfer_queue ftp_image_transfer_queue_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.ftp_image_transfer_queue
    ADD CONSTRAINT ftp_image_transfer_queue_pkey PRIMARY KEY (id);


--
-- Name: ftp_video_converted_buffer ftp_video_converted_buffer_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.ftp_video_converted_buffer
    ADD CONSTRAINT ftp_video_converted_buffer_pkey PRIMARY KEY (id);


--
-- Name: ftp_video_transfer_queue_job ftp_video_transfer_queue_job_batch_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.ftp_video_transfer_queue_job
    ADD CONSTRAINT ftp_video_transfer_queue_job_batch_id_key UNIQUE (batch_id);


--
-- Name: ftp_video_transfer_queue_job ftp_video_transfer_queue_job_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.ftp_video_transfer_queue_job
    ADD CONSTRAINT ftp_video_transfer_queue_job_pkey PRIMARY KEY (id);


--
-- Name: ftp_video_transfer_queue ftp_video_transfer_queue_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.ftp_video_transfer_queue
    ADD CONSTRAINT ftp_video_transfer_queue_pkey PRIMARY KEY (id);


--
-- Name: iss_media_files iss_media_files_file_path_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.iss_media_files
    ADD CONSTRAINT iss_media_files_file_path_key UNIQUE (file_path);


--
-- Name: iss_media_files iss_media_files_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.iss_media_files
    ADD CONSTRAINT iss_media_files_pkey PRIMARY KEY (id);


--
-- Name: transfer_job_log transfer_job_log_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.transfer_job_log
    ADD CONSTRAINT transfer_job_log_pkey PRIMARY KEY (id);


--
-- Name: transfer_job transfer_job_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.transfer_job
    ADD CONSTRAINT transfer_job_pkey PRIMARY KEY (id);


--
-- Name: transfer_queue_job transfer_queue_job_batch_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.transfer_queue_job
    ADD CONSTRAINT transfer_queue_job_batch_id_key UNIQUE (batch_id);


--
-- Name: transfer_queue_job transfer_queue_job_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.transfer_queue_job
    ADD CONSTRAINT transfer_queue_job_pkey PRIMARY KEY (id);


--
-- Name: transfer_queue transfer_queue_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.transfer_queue
    ADD CONSTRAINT transfer_queue_pkey PRIMARY KEY (id);


--
-- Name: ftp_video_converted_buffer uk_ftp_video_converted_buffer_camera_source_job; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.ftp_video_converted_buffer
    ADD CONSTRAINT uk_ftp_video_converted_buffer_camera_source_job UNIQUE (camera_id, source_file_id, job_id);


--
-- Name: ftp_video_transfer_queue uk_ftp_video_transfer_queue_job_camera; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.ftp_video_transfer_queue
    ADD CONSTRAINT uk_ftp_video_transfer_queue_job_camera UNIQUE (job_id, camera_id);


--
-- Name: video_converted_buffer uk_video_converted_buffer_camera_source_job; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.video_converted_buffer
    ADD CONSTRAINT uk_video_converted_buffer_camera_source_job UNIQUE (camera_id, source_file_id, job_id);


--
-- Name: video_transfer_queue uk_video_transfer_queue_job_camera; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.video_transfer_queue
    ADD CONSTRAINT uk_video_transfer_queue_job_camera UNIQUE (job_id, camera_id);


--
-- Name: video_converted_buffer video_converted_buffer_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.video_converted_buffer
    ADD CONSTRAINT video_converted_buffer_pkey PRIMARY KEY (id);


--
-- Name: video_transfer_queue_job video_transfer_queue_job_batch_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.video_transfer_queue_job
    ADD CONSTRAINT video_transfer_queue_job_batch_id_key UNIQUE (batch_id);


--
-- Name: video_transfer_queue_job video_transfer_queue_job_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.video_transfer_queue_job
    ADD CONSTRAINT video_transfer_queue_job_pkey PRIMARY KEY (id);


--
-- Name: video_transfer_queue video_transfer_queue_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.video_transfer_queue
    ADD CONSTRAINT video_transfer_queue_pkey PRIMARY KEY (id);


--
-- Name: idx_device_connections_status_connected; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_device_connections_status_connected ON public.device_connections USING btree (status) WHERE (status = 'connected'::text);


--
-- Name: idx_files_date_time; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_files_date_time ON public.files USING btree (((date + ("time")::interval))) WHERE (deleted = false);


--
-- Name: idx_files_grouping; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_files_grouping ON public.files USING btree (plate_num, site_id, date_folder, time_folder) WHERE (deleted = false);


--
-- Name: idx_files_pending_deletion; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_files_pending_deletion ON public.files USING btree (pending_deletion) WHERE (pending_deletion = true);


--
-- Name: idx_files_ts; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_files_ts ON public.files USING btree (ts);


--
-- Name: idx_ftp_image_transfer_queue_created_at; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_ftp_image_transfer_queue_created_at ON public.ftp_image_transfer_queue USING btree (created_at);


--
-- Name: idx_ftp_image_transfer_queue_file_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_ftp_image_transfer_queue_file_id ON public.ftp_image_transfer_queue USING btree (file_id);


--
-- Name: idx_ftp_image_transfer_queue_job_batch_origin; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_ftp_image_transfer_queue_job_batch_origin ON public.ftp_image_transfer_queue_job USING btree (batch_origin);


--
-- Name: idx_ftp_image_transfer_queue_job_created_at; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_ftp_image_transfer_queue_job_created_at ON public.ftp_image_transfer_queue_job USING btree (created_at);


--
-- Name: idx_ftp_image_transfer_queue_job_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_ftp_image_transfer_queue_job_id ON public.ftp_image_transfer_queue USING btree (job_id);


--
-- Name: idx_ftp_image_transfer_queue_job_status; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_ftp_image_transfer_queue_job_status ON public.ftp_image_transfer_queue_job USING btree (status);


--
-- Name: idx_ftp_image_transfer_queue_status; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_ftp_image_transfer_queue_status ON public.ftp_image_transfer_queue USING btree (status);


--
-- Name: idx_ftp_video_converted_buffer_camera_status; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_ftp_video_converted_buffer_camera_status ON public.ftp_video_converted_buffer USING btree (camera_id, status);


--
-- Name: idx_ftp_video_converted_buffer_group_key; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_ftp_video_converted_buffer_group_key ON public.ftp_video_converted_buffer USING btree (group_key);


--
-- Name: idx_ftp_video_converted_buffer_job_camera; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_ftp_video_converted_buffer_job_camera ON public.ftp_video_converted_buffer USING btree (job_id, camera_id);


--
-- Name: idx_ftp_video_converted_buffer_job_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_ftp_video_converted_buffer_job_id ON public.ftp_video_converted_buffer USING btree (job_id);


--
-- Name: idx_ftp_video_converted_buffer_job_status; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_ftp_video_converted_buffer_job_status ON public.ftp_video_converted_buffer USING btree (job_id, status);


--
-- Name: idx_ftp_video_converted_buffer_source_file_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_ftp_video_converted_buffer_source_file_id ON public.ftp_video_converted_buffer USING btree (source_file_id);


--
-- Name: idx_ftp_video_transfer_queue_camera_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_ftp_video_transfer_queue_camera_id ON public.ftp_video_transfer_queue USING btree (camera_id);


--
-- Name: idx_ftp_video_transfer_queue_job_batch_origin; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_ftp_video_transfer_queue_job_batch_origin ON public.ftp_video_transfer_queue_job USING btree (batch_origin);


--
-- Name: idx_ftp_video_transfer_queue_job_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_ftp_video_transfer_queue_job_id ON public.ftp_video_transfer_queue USING btree (job_id);


--
-- Name: idx_ftp_video_transfer_queue_job_status; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_ftp_video_transfer_queue_job_status ON public.ftp_video_transfer_queue_job USING btree (status);


--
-- Name: idx_ftp_video_transfer_queue_status; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_ftp_video_transfer_queue_status ON public.ftp_video_transfer_queue USING btree (status);


--
-- Name: idx_iss_media_files_auto_transferred; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_iss_media_files_auto_transferred ON public.iss_media_files USING btree (is_auto_transferred) WHERE (is_auto_transferred = false);


--
-- Name: idx_iss_media_files_camera_date; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_iss_media_files_camera_date ON public.iss_media_files USING btree (camera_id, recording_date);


--
-- Name: idx_iss_media_files_deleted; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_iss_media_files_deleted ON public.iss_media_files USING btree (deleted) WHERE (deleted = false);


--
-- Name: idx_transfer_queue_created_at; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_transfer_queue_created_at ON public.transfer_queue USING btree (created_at);


--
-- Name: idx_transfer_queue_file_origin; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_transfer_queue_file_origin ON public.transfer_queue USING btree (file_origin);


--
-- Name: idx_transfer_queue_job_batch_origin; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_transfer_queue_job_batch_origin ON public.transfer_queue_job USING btree (batch_origin);


--
-- Name: idx_transfer_queue_job_created_at; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_transfer_queue_job_created_at ON public.transfer_queue_job USING btree (created_at);


--
-- Name: idx_transfer_queue_job_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_transfer_queue_job_id ON public.transfer_queue USING btree (job_id);


--
-- Name: idx_transfer_queue_job_status; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_transfer_queue_job_status ON public.transfer_queue_job USING btree (status);


--
-- Name: idx_transfer_queue_status; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_transfer_queue_status ON public.transfer_queue USING btree (status);


--
-- Name: idx_video_converted_buffer_camera_status; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_video_converted_buffer_camera_status ON public.video_converted_buffer USING btree (camera_id, status);


--
-- Name: idx_video_converted_buffer_group_key; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_video_converted_buffer_group_key ON public.video_converted_buffer USING btree (group_key);


--
-- Name: idx_video_converted_buffer_job_camera; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_video_converted_buffer_job_camera ON public.video_converted_buffer USING btree (job_id, camera_id);


--
-- Name: idx_video_converted_buffer_job_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_video_converted_buffer_job_id ON public.video_converted_buffer USING btree (job_id);


--
-- Name: idx_video_converted_buffer_job_status; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_video_converted_buffer_job_status ON public.video_converted_buffer USING btree (job_id, status);


--
-- Name: idx_video_converted_buffer_source_file_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_video_converted_buffer_source_file_id ON public.video_converted_buffer USING btree (source_file_id);


--
-- Name: idx_video_transfer_queue_camera_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_video_transfer_queue_camera_id ON public.video_transfer_queue USING btree (camera_id);


--
-- Name: idx_video_transfer_queue_job_batch_origin; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_video_transfer_queue_job_batch_origin ON public.video_transfer_queue_job USING btree (batch_origin);


--
-- Name: idx_video_transfer_queue_job_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_video_transfer_queue_job_id ON public.video_transfer_queue USING btree (job_id);


--
-- Name: idx_video_transfer_queue_job_status; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_video_transfer_queue_job_status ON public.video_transfer_queue_job USING btree (status);


--
-- Name: idx_video_transfer_queue_status; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_video_transfer_queue_status ON public.video_transfer_queue USING btree (status);


--
-- Name: transfer_queue_job trigger_transfer_queue_job_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trigger_transfer_queue_job_updated_at BEFORE UPDATE ON public.transfer_queue_job FOR EACH ROW EXECUTE FUNCTION public.update_transfer_queue_job_updated_at();


--
-- Name: transfer_queue trigger_transfer_queue_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trigger_transfer_queue_updated_at BEFORE UPDATE ON public.transfer_queue FOR EACH ROW EXECUTE FUNCTION public.update_transfer_queue_updated_at();


--
-- Name: files update_files_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER update_files_updated_at BEFORE UPDATE ON public.files FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: ftp_image_transfer_queue_job update_ftp_image_transfer_queue_job_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER update_ftp_image_transfer_queue_job_updated_at BEFORE UPDATE ON public.ftp_image_transfer_queue_job FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: ftp_image_transfer_queue update_ftp_image_transfer_queue_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER update_ftp_image_transfer_queue_updated_at BEFORE UPDATE ON public.ftp_image_transfer_queue FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: ftp_video_converted_buffer update_ftp_video_converted_buffer_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER update_ftp_video_converted_buffer_updated_at BEFORE UPDATE ON public.ftp_video_converted_buffer FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: ftp_video_transfer_queue_job update_ftp_video_transfer_queue_job_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER update_ftp_video_transfer_queue_job_updated_at BEFORE UPDATE ON public.ftp_video_transfer_queue_job FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: ftp_video_transfer_queue update_ftp_video_transfer_queue_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER update_ftp_video_transfer_queue_updated_at BEFORE UPDATE ON public.ftp_video_transfer_queue FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: video_converted_buffer update_video_converted_buffer_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER update_video_converted_buffer_updated_at BEFORE UPDATE ON public.video_converted_buffer FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: video_transfer_queue_job update_video_transfer_queue_job_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER update_video_transfer_queue_job_updated_at BEFORE UPDATE ON public.video_transfer_queue_job FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: video_transfer_queue update_video_transfer_queue_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER update_video_transfer_queue_updated_at BEFORE UPDATE ON public.video_transfer_queue FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: auto_transfer_job fk_auto_transfer_device; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.auto_transfer_job
    ADD CONSTRAINT fk_auto_transfer_device FOREIGN KEY (auto_transfer_device_id) REFERENCES public.auto_transfer_device(id);


--
-- Name: transfer_job_log fk_file; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.transfer_job_log
    ADD CONSTRAINT fk_file FOREIGN KEY (file_id) REFERENCES public.files(id);


--
-- Name: ftp_image_transfer_queue fk_ftp_image_transfer_queue_file; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.ftp_image_transfer_queue
    ADD CONSTRAINT fk_ftp_image_transfer_queue_file FOREIGN KEY (file_id) REFERENCES public.files(id) ON DELETE CASCADE;


--
-- Name: ftp_image_transfer_queue fk_ftp_image_transfer_queue_job; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.ftp_image_transfer_queue
    ADD CONSTRAINT fk_ftp_image_transfer_queue_job FOREIGN KEY (job_id) REFERENCES public.ftp_image_transfer_queue_job(id) ON DELETE CASCADE;


--
-- Name: ftp_video_converted_buffer fk_ftp_video_converted_buffer_job; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.ftp_video_converted_buffer
    ADD CONSTRAINT fk_ftp_video_converted_buffer_job FOREIGN KEY (job_id) REFERENCES public.ftp_video_transfer_queue_job(id) ON DELETE CASCADE;


--
-- Name: ftp_video_converted_buffer fk_ftp_video_converted_buffer_source; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.ftp_video_converted_buffer
    ADD CONSTRAINT fk_ftp_video_converted_buffer_source FOREIGN KEY (source_file_id) REFERENCES public.iss_media_files(id) ON DELETE CASCADE;


--
-- Name: transfer_job_log fk_transfer_job; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.transfer_job_log
    ADD CONSTRAINT fk_transfer_job FOREIGN KEY (transfer_job_id) REFERENCES public.transfer_job(id);


--
-- Name: transfer_queue fk_transfer_queue_file; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.transfer_queue
    ADD CONSTRAINT fk_transfer_queue_file FOREIGN KEY (file_id) REFERENCES public.files(id) ON DELETE CASCADE;


--
-- Name: transfer_queue fk_transfer_queue_job; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.transfer_queue
    ADD CONSTRAINT fk_transfer_queue_job FOREIGN KEY (job_id) REFERENCES public.transfer_queue_job(id) ON DELETE CASCADE;


--
-- Name: video_converted_buffer fk_video_converted_buffer_job; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.video_converted_buffer
    ADD CONSTRAINT fk_video_converted_buffer_job FOREIGN KEY (job_id) REFERENCES public.video_transfer_queue_job(id) ON DELETE CASCADE;


--
-- Name: video_converted_buffer fk_video_converted_buffer_source; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.video_converted_buffer
    ADD CONSTRAINT fk_video_converted_buffer_source FOREIGN KEY (source_file_id) REFERENCES public.iss_media_files(id) ON DELETE CASCADE;


--
-- Name: ftp_video_transfer_queue ftp_video_transfer_queue_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.ftp_video_transfer_queue
    ADD CONSTRAINT ftp_video_transfer_queue_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.ftp_video_transfer_queue_job(id);


--
-- Name: video_transfer_queue video_transfer_queue_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.video_transfer_queue
    ADD CONSTRAINT video_transfer_queue_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.video_transfer_queue_job(id);


--
-- PostgreSQL database dump complete
--

