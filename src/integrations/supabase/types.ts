export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.4"
  }
  public: {
    Tables: {
      app_admin_2fa_state: {
        Row: {
          created_at: string
          expires_at: string
          otp_verified_at: string | null
          token_hash: string
          totp_verified_at: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          expires_at?: string
          otp_verified_at?: string | null
          token_hash: string
          totp_verified_at?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          expires_at?: string
          otp_verified_at?: string | null
          token_hash?: string
          totp_verified_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "app_admin_2fa_state_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
        ]
      }
      app_otps: {
        Row: {
          created_at: string
          expires_at: string
          id: string
          otp: string
          user_id: string
        }
        Insert: {
          created_at?: string
          expires_at?: string
          id?: string
          otp: string
          user_id: string
        }
        Update: {
          created_at?: string
          expires_at?: string
          id?: string
          otp?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "app_otps_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
        ]
      }
      app_sessions: {
        Row: {
          binding_hash: string | null
          created_at: string
          expires_at: string
          family_id: string | null
          id: string
          ip: string | null
          last_seen_at: string
          parent_session_id: string | null
          refresh_expires_at: string | null
          refresh_token_hash: string | null
          revoked_at: string | null
          revoked_reason: string | null
          role: string
          token_hash: string
          user_agent: string | null
          user_id: string
        }
        Insert: {
          binding_hash?: string | null
          created_at?: string
          expires_at: string
          family_id?: string | null
          id?: string
          ip?: string | null
          last_seen_at?: string
          parent_session_id?: string | null
          refresh_expires_at?: string | null
          refresh_token_hash?: string | null
          revoked_at?: string | null
          revoked_reason?: string | null
          role?: string
          token_hash: string
          user_agent?: string | null
          user_id: string
        }
        Update: {
          binding_hash?: string | null
          created_at?: string
          expires_at?: string
          family_id?: string | null
          id?: string
          ip?: string | null
          last_seen_at?: string
          parent_session_id?: string | null
          refresh_expires_at?: string | null
          refresh_token_hash?: string | null
          revoked_at?: string | null
          revoked_reason?: string | null
          role?: string
          token_hash?: string
          user_agent?: string | null
          user_id?: string
        }
        Relationships: []
      }
      app_settings: {
        Row: {
          key: string
          value: Json
        }
        Insert: {
          key: string
          value?: Json
        }
        Update: {
          key?: string
          value?: Json
        }
        Relationships: []
      }
      app_users: {
        Row: {
          assigned_accounts: Json | null
          auto_delete: boolean
          created_at: string
          expires_at: string | null
          id: string
          is_free: boolean
          must_change_password: boolean
          name: string
          password: string | null
          pinned: boolean
          profile_prefs: Json
          role: string
          session_limit: number | null
          sort_order: number | null
          totp_secret: string | null
          tv_override: string | null
          username: string | null
        }
        Insert: {
          assigned_accounts?: Json | null
          auto_delete?: boolean
          created_at?: string
          expires_at?: string | null
          id?: string
          is_free?: boolean
          must_change_password?: boolean
          name: string
          password?: string | null
          pinned?: boolean
          profile_prefs?: Json
          role?: string
          session_limit?: number | null
          sort_order?: number | null
          totp_secret?: string | null
          tv_override?: string | null
          username?: string | null
        }
        Update: {
          assigned_accounts?: Json | null
          auto_delete?: boolean
          created_at?: string
          expires_at?: string | null
          id?: string
          is_free?: boolean
          must_change_password?: boolean
          name?: string
          password?: string | null
          pinned?: boolean
          profile_prefs?: Json
          role?: string
          session_limit?: number | null
          sort_order?: number | null
          totp_secret?: string | null
          tv_override?: string | null
          username?: string | null
        }
        Relationships: []
      }
      audit_logs: {
        Row: {
          action: string
          actor_id: string | null
          created_at: string
          details: Json | null
          id: string
          ip: string | null
          result: string | null
          target_id: string | null
          user_agent: string | null
        }
        Insert: {
          action: string
          actor_id?: string | null
          created_at?: string
          details?: Json | null
          id?: string
          ip?: string | null
          result?: string | null
          target_id?: string | null
          user_agent?: string | null
        }
        Update: {
          action?: string
          actor_id?: string | null
          created_at?: string
          details?: Json | null
          id?: string
          ip?: string | null
          result?: string | null
          target_id?: string | null
          user_agent?: string | null
        }
        Relationships: []
      }
      cached_emails: {
        Row: {
          account_label: string | null
          cached_at: string
          date: string | null
          destroyed: boolean
          from_address: string | null
          html: string | null
          id: string
          message_id: string | null
          modseq: number
          otp: string | null
          preview: string | null
          subject: string | null
          to_address: string | null
        }
        Insert: {
          account_label?: string | null
          cached_at?: string
          date?: string | null
          destroyed?: boolean
          from_address?: string | null
          html?: string | null
          id: string
          message_id?: string | null
          modseq?: number
          otp?: string | null
          preview?: string | null
          subject?: string | null
          to_address?: string | null
        }
        Update: {
          account_label?: string | null
          cached_at?: string
          date?: string | null
          destroyed?: boolean
          from_address?: string | null
          html?: string | null
          id?: string
          message_id?: string | null
          modseq?: number
          otp?: string | null
          preview?: string | null
          subject?: string | null
          to_address?: string | null
        }
        Relationships: []
      }
      crypto_nonces: {
        Row: {
          nonce: string
          seen_at: string
          session_id: string
        }
        Insert: {
          nonce: string
          seen_at?: string
          session_id: string
        }
        Update: {
          nonce?: string
          seen_at?: string
          session_id?: string
        }
        Relationships: []
      }
      crypto_sessions: {
        Row: {
          aes_key: string
          created_at: string
          expires_at: string
          id: string
          ip: string | null
          origin_hash: string | null
        }
        Insert: {
          aes_key: string
          created_at?: string
          expires_at?: string
          id?: string
          ip?: string | null
          origin_hash?: string | null
        }
        Update: {
          aes_key?: string
          created_at?: string
          expires_at?: string
          id?: string
          ip?: string | null
          origin_hash?: string | null
        }
        Relationships: []
      }
      handshake_rate: {
        Row: {
          count: number
          ip: string
          minute_bucket: string
        }
        Insert: {
          count?: number
          ip: string
          minute_bucket: string
        }
        Update: {
          count?: number
          ip?: string
          minute_bucket?: string
        }
        Relationships: []
      }
      login_events: {
        Row: {
          asn: string | null
          battery_charging: boolean | null
          battery_level: number | null
          browser_engine: string | null
          browser_name: string | null
          browser_version: string | null
          calling_code: string | null
          city: string | null
          color_depth: number | null
          connection_type: string | null
          country: string | null
          country_code: string | null
          created_at: string
          currency: string | null
          device_brand: string | null
          device_memory: number | null
          device_model: string | null
          device_type: string | null
          district: string | null
          downlink: number | null
          event: string
          fingerprint_hash: string | null
          gps_accuracy: number | null
          gps_altitude: number | null
          gps_captured_at: string | null
          gps_heading: number | null
          gps_lat: number | null
          gps_lon: number | null
          gps_speed: number | null
          hardware_concurrency: number | null
          id: string
          impossible_travel: boolean | null
          ip: string | null
          ip_lat: number | null
          ip_lon: number | null
          ip_source: string | null
          is_hosting: boolean | null
          is_new_device: boolean | null
          is_proxy: boolean | null
          is_tor: boolean | null
          is_vpn: boolean | null
          isp: string | null
          languages: string[] | null
          network_type: string | null
          org: string | null
          orientation: string | null
          os_name: string | null
          os_version: string | null
          pixel_ratio: number | null
          platform: string | null
          raw: Json | null
          region: string | null
          risk_reasons: string[] | null
          risk_score: string | null
          role: string | null
          rtt: number | null
          save_data: boolean | null
          screen_h: number | null
          screen_w: number | null
          session_duration_seconds: number | null
          session_id: string | null
          timezone: string | null
          user_agent: string | null
          user_id: string
          username: string | null
          utc_offset: string | null
          viewport_h: number | null
          viewport_w: number | null
          zip: string | null
        }
        Insert: {
          asn?: string | null
          battery_charging?: boolean | null
          battery_level?: number | null
          browser_engine?: string | null
          browser_name?: string | null
          browser_version?: string | null
          calling_code?: string | null
          city?: string | null
          color_depth?: number | null
          connection_type?: string | null
          country?: string | null
          country_code?: string | null
          created_at?: string
          currency?: string | null
          device_brand?: string | null
          device_memory?: number | null
          device_model?: string | null
          device_type?: string | null
          district?: string | null
          downlink?: number | null
          event: string
          fingerprint_hash?: string | null
          gps_accuracy?: number | null
          gps_altitude?: number | null
          gps_captured_at?: string | null
          gps_heading?: number | null
          gps_lat?: number | null
          gps_lon?: number | null
          gps_speed?: number | null
          hardware_concurrency?: number | null
          id?: string
          impossible_travel?: boolean | null
          ip?: string | null
          ip_lat?: number | null
          ip_lon?: number | null
          ip_source?: string | null
          is_hosting?: boolean | null
          is_new_device?: boolean | null
          is_proxy?: boolean | null
          is_tor?: boolean | null
          is_vpn?: boolean | null
          isp?: string | null
          languages?: string[] | null
          network_type?: string | null
          org?: string | null
          orientation?: string | null
          os_name?: string | null
          os_version?: string | null
          pixel_ratio?: number | null
          platform?: string | null
          raw?: Json | null
          region?: string | null
          risk_reasons?: string[] | null
          risk_score?: string | null
          role?: string | null
          rtt?: number | null
          save_data?: boolean | null
          screen_h?: number | null
          screen_w?: number | null
          session_duration_seconds?: number | null
          session_id?: string | null
          timezone?: string | null
          user_agent?: string | null
          user_id: string
          username?: string | null
          utc_offset?: string | null
          viewport_h?: number | null
          viewport_w?: number | null
          zip?: string | null
        }
        Update: {
          asn?: string | null
          battery_charging?: boolean | null
          battery_level?: number | null
          browser_engine?: string | null
          browser_name?: string | null
          browser_version?: string | null
          calling_code?: string | null
          city?: string | null
          color_depth?: number | null
          connection_type?: string | null
          country?: string | null
          country_code?: string | null
          created_at?: string
          currency?: string | null
          device_brand?: string | null
          device_memory?: number | null
          device_model?: string | null
          device_type?: string | null
          district?: string | null
          downlink?: number | null
          event?: string
          fingerprint_hash?: string | null
          gps_accuracy?: number | null
          gps_altitude?: number | null
          gps_captured_at?: string | null
          gps_heading?: number | null
          gps_lat?: number | null
          gps_lon?: number | null
          gps_speed?: number | null
          hardware_concurrency?: number | null
          id?: string
          impossible_travel?: boolean | null
          ip?: string | null
          ip_lat?: number | null
          ip_lon?: number | null
          ip_source?: string | null
          is_hosting?: boolean | null
          is_new_device?: boolean | null
          is_proxy?: boolean | null
          is_tor?: boolean | null
          is_vpn?: boolean | null
          isp?: string | null
          languages?: string[] | null
          network_type?: string | null
          org?: string | null
          orientation?: string | null
          os_name?: string | null
          os_version?: string | null
          pixel_ratio?: number | null
          platform?: string | null
          raw?: Json | null
          region?: string | null
          risk_reasons?: string[] | null
          risk_score?: string | null
          role?: string | null
          rtt?: number | null
          save_data?: boolean | null
          screen_h?: number | null
          screen_w?: number | null
          session_duration_seconds?: number | null
          session_id?: string | null
          timezone?: string | null
          user_agent?: string | null
          user_id?: string
          username?: string | null
          utc_offset?: string | null
          viewport_h?: number | null
          viewport_w?: number | null
          zip?: string | null
        }
        Relationships: []
      }
      netflix_sessions: {
        Row: {
          account_label: string | null
          cookies_json: string | null
          created_at: string
          email: string
          id: string
          last_error: string | null
          last_login_at: string | null
          logs: Json
          status: string
          updated_at: string
        }
        Insert: {
          account_label?: string | null
          cookies_json?: string | null
          created_at?: string
          email: string
          id?: string
          last_error?: string | null
          last_login_at?: string | null
          logs?: Json
          status?: string
          updated_at?: string
        }
        Update: {
          account_label?: string | null
          cookies_json?: string | null
          created_at?: string
          email?: string
          id?: string
          last_error?: string | null
          last_login_at?: string | null
          logs?: Json
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      notification_events: {
        Row: {
          at: string
          event: string
          id: string
          meta: Json | null
          notification_id: string
          user_id: string
        }
        Insert: {
          at?: string
          event: string
          id?: string
          meta?: Json | null
          notification_id: string
          user_id: string
        }
        Update: {
          at?: string
          event?: string
          id?: string
          meta?: Json | null
          notification_id?: string
          user_id?: string
        }
        Relationships: []
      }
      notification_impressions: {
        Row: {
          clicked_at: string | null
          completed_at: string | null
          dismissed_at: string | null
          first_shown_at: string | null
          id: string
          meta: Json | null
          notification_id: string
          times_shown: number
          updated_at: string
          user_id: string
        }
        Insert: {
          clicked_at?: string | null
          completed_at?: string | null
          dismissed_at?: string | null
          first_shown_at?: string | null
          id?: string
          meta?: Json | null
          notification_id: string
          times_shown?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          clicked_at?: string | null
          completed_at?: string | null
          dismissed_at?: string | null
          first_shown_at?: string | null
          id?: string
          meta?: Json | null
          notification_id?: string
          times_shown?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notification_impressions_notification_id_fkey"
            columns: ["notification_id"]
            isOneToOne: false
            referencedRelation: "notifications"
            referencedColumns: ["id"]
          },
        ]
      }
      notification_prefs: {
        Row: {
          category: string
          created_at: string
          digest_frequency: string
          email_enabled: boolean
          id: string
          in_app_enabled: boolean
          push_enabled: boolean
          quiet_hours_end: string | null
          quiet_hours_start: string | null
          quiet_tz: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          category?: string
          created_at?: string
          digest_frequency?: string
          email_enabled?: boolean
          id?: string
          in_app_enabled?: boolean
          push_enabled?: boolean
          quiet_hours_end?: string | null
          quiet_hours_start?: string | null
          quiet_tz?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          category?: string
          created_at?: string
          digest_frequency?: string
          email_enabled?: boolean
          id?: string
          in_app_enabled?: boolean
          push_enabled?: boolean
          quiet_hours_end?: string | null
          quiet_hours_start?: string | null
          quiet_tz?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      notification_reads: {
        Row: {
          archived_at: string | null
          clicked_at: string | null
          deleted_at: string | null
          dismissed_at: string | null
          notification_id: string
          read_at: string
          seen_at: string | null
          snoozed_until: string | null
          user_id: string
        }
        Insert: {
          archived_at?: string | null
          clicked_at?: string | null
          deleted_at?: string | null
          dismissed_at?: string | null
          notification_id: string
          read_at?: string
          seen_at?: string | null
          snoozed_until?: string | null
          user_id: string
        }
        Update: {
          archived_at?: string | null
          clicked_at?: string | null
          deleted_at?: string | null
          dismissed_at?: string | null
          notification_id?: string
          read_at?: string
          seen_at?: string | null
          snoozed_until?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notification_reads_notification_id_fkey"
            columns: ["notification_id"]
            isOneToOne: false
            referencedRelation: "notifications"
            referencedColumns: ["id"]
          },
        ]
      }
      notification_translations: {
        Row: {
          body: string | null
          body_markdown: string | null
          created_at: string
          lang: string
          notification_id: string
          title: string | null
        }
        Insert: {
          body?: string | null
          body_markdown?: string | null
          created_at?: string
          lang: string
          notification_id: string
          title?: string | null
        }
        Update: {
          body?: string | null
          body_markdown?: string | null
          created_at?: string
          lang?: string
          notification_id?: string
          title?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "notification_translations_notification_id_fkey"
            columns: ["notification_id"]
            isOneToOne: false
            referencedRelation: "notifications"
            referencedColumns: ["id"]
          },
        ]
      }
      notifications: {
        Row: {
          action_label: string | null
          action_url: string | null
          action2_label: string | null
          action2_url: string | null
          audience: string
          body: string
          body_markdown: string | null
          category: string
          created_at: string
          created_by: string | null
          dedupe_key: string | null
          description: string | null
          expires_at: string | null
          genre_tags: string[] | null
          group_key: string | null
          icon: string | null
          id: string
          image_key: string | null
          image_url: string | null
          kind: string
          language: string | null
          locked: boolean
          mode: string | null
          pinned: boolean
          platform_icon: string | null
          priority: string
          publish_at: string | null
          rating: number | null
          show_frequency: string | null
          sub_kind: string | null
          target_user_id: string | null
          title: string
        }
        Insert: {
          action_label?: string | null
          action_url?: string | null
          action2_label?: string | null
          action2_url?: string | null
          audience: string
          body: string
          body_markdown?: string | null
          category?: string
          created_at?: string
          created_by?: string | null
          dedupe_key?: string | null
          description?: string | null
          expires_at?: string | null
          genre_tags?: string[] | null
          group_key?: string | null
          icon?: string | null
          id?: string
          image_key?: string | null
          image_url?: string | null
          kind?: string
          language?: string | null
          locked?: boolean
          mode?: string | null
          pinned?: boolean
          platform_icon?: string | null
          priority?: string
          publish_at?: string | null
          rating?: number | null
          show_frequency?: string | null
          sub_kind?: string | null
          target_user_id?: string | null
          title: string
        }
        Update: {
          action_label?: string | null
          action_url?: string | null
          action2_label?: string | null
          action2_url?: string | null
          audience?: string
          body?: string
          body_markdown?: string | null
          category?: string
          created_at?: string
          created_by?: string | null
          dedupe_key?: string | null
          description?: string | null
          expires_at?: string | null
          genre_tags?: string[] | null
          group_key?: string | null
          icon?: string | null
          id?: string
          image_key?: string | null
          image_url?: string | null
          kind?: string
          language?: string | null
          locked?: boolean
          mode?: string | null
          pinned?: boolean
          platform_icon?: string | null
          priority?: string
          publish_at?: string | null
          rating?: number | null
          show_frequency?: string | null
          sub_kind?: string | null
          target_user_id?: string | null
          title?: string
        }
        Relationships: []
      }
      push_subscriptions: {
        Row: {
          auth: string
          created_at: string
          endpoint: string
          id: string
          p256dh: string
          ua: string | null
          user_id: string
        }
        Insert: {
          auth: string
          created_at?: string
          endpoint: string
          id?: string
          p256dh: string
          ua?: string | null
          user_id: string
        }
        Update: {
          auth?: string
          created_at?: string
          endpoint?: string
          id?: string
          p256dh?: string
          ua?: string | null
          user_id?: string
        }
        Relationships: []
      }
      security_events: {
        Row: {
          id: number
          ip: unknown
          meta: Json
          severity: string
          ts: string
          type: string
          ua: string | null
          uid: string | null
        }
        Insert: {
          id?: number
          ip?: unknown
          meta?: Json
          severity?: string
          ts?: string
          type: string
          ua?: string | null
          uid?: string | null
        }
        Update: {
          id?: number
          ip?: unknown
          meta?: Json
          severity?: string
          ts?: string
          type?: string
          ua?: string | null
          uid?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      get_cron_status: { Args: never; Returns: Json }
      get_email_cleanup_status: { Args: never; Returns: Json }
      purge_expired_crypto_sessions: { Args: never; Returns: undefined }
      purge_expired_free_profiles: { Args: never; Returns: number }
      purge_expired_nonces: { Args: never; Returns: undefined }
      schedule_email_cleanup: {
        Args: { days: number; hour: number }
        Returns: undefined
      }
      schedule_email_sync: {
        Args: { auth_key: string; cron_expr: string; function_url: string }
        Returns: undefined
      }
      unschedule_email_cleanup: { Args: never; Returns: undefined }
      unschedule_email_sync: { Args: never; Returns: undefined }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
