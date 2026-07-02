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
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      customers: {
        Row: {
          address_line1: string | null
          address_line2: string | null
          attributes: Json
          city: string | null
          created_at: string
          email: string | null
          id: string
          name: string
          phone: string | null
          postal_code: string | null
          source_capture_id: string | null
          state: string | null
          tenant_id: string
          updated_at: string
        }
        Insert: {
          address_line1?: string | null
          address_line2?: string | null
          attributes?: Json
          city?: string | null
          created_at?: string
          email?: string | null
          id?: string
          name: string
          phone?: string | null
          postal_code?: string | null
          source_capture_id?: string | null
          state?: string | null
          tenant_id: string
          updated_at?: string
        }
        Update: {
          address_line1?: string | null
          address_line2?: string | null
          attributes?: Json
          city?: string | null
          created_at?: string
          email?: string | null
          id?: string
          name?: string
          phone?: string | null
          postal_code?: string | null
          source_capture_id?: string | null
          state?: string | null
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "customers_source_capture_fk"
            columns: ["source_capture_id"]
            isOneToOne: false
            referencedRelation: "raw_captures"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customers_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      dropped_audit: {
        Row: {
          channel: Database["public"]["Enums"]["capture_channel"]
          classifier_reason: string | null
          dropped_at: string
          expires_at: string
          external_id: string | null
          id: string
          sender_domain: string | null
          technician_ref: string | null
          tenant_id: string
        }
        Insert: {
          channel: Database["public"]["Enums"]["capture_channel"]
          classifier_reason?: string | null
          dropped_at?: string
          expires_at?: string
          external_id?: string | null
          id?: string
          sender_domain?: string | null
          technician_ref?: string | null
          tenant_id: string
        }
        Update: {
          channel?: Database["public"]["Enums"]["capture_channel"]
          classifier_reason?: string | null
          dropped_at?: string
          expires_at?: string
          external_id?: string | null
          id?: string
          sender_domain?: string | null
          technician_ref?: string | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "dropped_audit_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      jobs: {
        Row: {
          attributes: Json
          created_at: string
          customer_id: string
          id: string
          job_type: string | null
          price_cents: number | null
          source_capture_id: string | null
          status: Database["public"]["Enums"]["job_status"]
          tenant_id: string
          title: string | null
          updated_at: string
        }
        Insert: {
          attributes?: Json
          created_at?: string
          customer_id: string
          id?: string
          job_type?: string | null
          price_cents?: number | null
          source_capture_id?: string | null
          status?: Database["public"]["Enums"]["job_status"]
          tenant_id: string
          title?: string | null
          updated_at?: string
        }
        Update: {
          attributes?: Json
          created_at?: string
          customer_id?: string
          id?: string
          job_type?: string | null
          price_cents?: number | null
          source_capture_id?: string | null
          status?: Database["public"]["Enums"]["job_status"]
          tenant_id?: string
          title?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "jobs_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jobs_source_capture_fk"
            columns: ["source_capture_id"]
            isOneToOne: false
            referencedRelation: "raw_captures"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jobs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      raw_captures: {
        Row: {
          blob_path: string | null
          captured_at: string
          channel: Database["public"]["Enums"]["capture_channel"]
          created_at: string
          customer_id: string | null
          external_id: string | null
          id: string
          job_id: string | null
          metadata: Json
          raw_text: string | null
          technician_ref: string | null
          tenant_id: string
          visit_id: string | null
        }
        Insert: {
          blob_path?: string | null
          captured_at?: string
          channel: Database["public"]["Enums"]["capture_channel"]
          created_at?: string
          customer_id?: string | null
          external_id?: string | null
          id?: string
          job_id?: string | null
          metadata?: Json
          raw_text?: string | null
          technician_ref?: string | null
          tenant_id: string
          visit_id?: string | null
        }
        Update: {
          blob_path?: string | null
          captured_at?: string
          channel?: Database["public"]["Enums"]["capture_channel"]
          created_at?: string
          customer_id?: string | null
          external_id?: string | null
          id?: string
          job_id?: string | null
          metadata?: Json
          raw_text?: string | null
          technician_ref?: string | null
          tenant_id?: string
          visit_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "raw_captures_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "raw_captures_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "raw_captures_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "raw_captures_visit_id_fkey"
            columns: ["visit_id"]
            isOneToOne: false
            referencedRelation: "visits"
            referencedColumns: ["id"]
          },
        ]
      }
      review_items: {
        Row: {
          created_at: string
          detail: Json
          id: string
          kind: string
          resolution: string | null
          resolved_at: string | null
          status: Database["public"]["Enums"]["review_status"]
          subject_ref: string
          suggestion: string | null
          tenant_id: string
        }
        Insert: {
          created_at?: string
          detail?: Json
          id?: string
          kind: string
          resolution?: string | null
          resolved_at?: string | null
          status?: Database["public"]["Enums"]["review_status"]
          subject_ref: string
          suggestion?: string | null
          tenant_id: string
        }
        Update: {
          created_at?: string
          detail?: Json
          id?: string
          kind?: string
          resolution?: string | null
          resolved_at?: string | null
          status?: Database["public"]["Enums"]["review_status"]
          subject_ref?: string
          suggestion?: string | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "review_items_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      schedule_entries: {
        Row: {
          address_line1: string | null
          attributes: Json
          city: string | null
          created_at: string
          customer_id: string | null
          customer_name: string | null
          external_row_key: string
          id: string
          job_id: string | null
          phone: string | null
          postal_code: string | null
          scheduled_end: string | null
          scheduled_start: string | null
          source: string
          state: string | null
          technician_ref: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          address_line1?: string | null
          attributes?: Json
          city?: string | null
          created_at?: string
          customer_id?: string | null
          customer_name?: string | null
          external_row_key: string
          id?: string
          job_id?: string | null
          phone?: string | null
          postal_code?: string | null
          scheduled_end?: string | null
          scheduled_start?: string | null
          source?: string
          state?: string | null
          technician_ref: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          address_line1?: string | null
          attributes?: Json
          city?: string | null
          created_at?: string
          customer_id?: string | null
          customer_name?: string | null
          external_row_key?: string
          id?: string
          job_id?: string | null
          phone?: string | null
          postal_code?: string | null
          scheduled_end?: string | null
          scheduled_start?: string | null
          source?: string
          state?: string | null
          technician_ref?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "schedule_entries_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "schedule_entries_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "schedule_entries_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      technicians: {
        Row: {
          composio_connected_account_id: string | null
          composio_trigger_id: string | null
          connected_email: string | null
          created_at: string
          display_name: string
          id: string
          ref: string
          sandbox_ref: string | null
          state: Database["public"]["Enums"]["technician_state"]
          tenant_id: string
          tier: Database["public"]["Enums"]["technician_tier"]
          updated_at: string
        }
        Insert: {
          composio_connected_account_id?: string | null
          composio_trigger_id?: string | null
          connected_email?: string | null
          created_at?: string
          display_name: string
          id?: string
          ref: string
          sandbox_ref?: string | null
          state?: Database["public"]["Enums"]["technician_state"]
          tenant_id: string
          tier?: Database["public"]["Enums"]["technician_tier"]
          updated_at?: string
        }
        Update: {
          composio_connected_account_id?: string | null
          composio_trigger_id?: string | null
          connected_email?: string | null
          created_at?: string
          display_name?: string
          id?: string
          ref?: string
          sandbox_ref?: string | null
          state?: Database["public"]["Enums"]["technician_state"]
          tenant_id?: string
          tier?: Database["public"]["Enums"]["technician_tier"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "technicians_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenants: {
        Row: {
          created_at: string
          id: string
          manager_seats: number
          name: string
          technician_seats: number
        }
        Insert: {
          created_at?: string
          id?: string
          manager_seats?: number
          name: string
          technician_seats?: number
        }
        Update: {
          created_at?: string
          id?: string
          manager_seats?: number
          name?: string
          technician_seats?: number
        }
        Relationships: []
      }
      visits: {
        Row: {
          attributes: Json
          completed_at: string | null
          created_at: string
          id: string
          job_id: string
          labor_hours: number | null
          scheduled_at: string | null
          source_capture_id: string | null
          started_at: string | null
          technician_name: string | null
          tenant_id: string
        }
        Insert: {
          attributes?: Json
          completed_at?: string | null
          created_at?: string
          id?: string
          job_id: string
          labor_hours?: number | null
          scheduled_at?: string | null
          source_capture_id?: string | null
          started_at?: string | null
          technician_name?: string | null
          tenant_id: string
        }
        Update: {
          attributes?: Json
          completed_at?: string | null
          created_at?: string
          id?: string
          job_id?: string
          labor_hours?: number | null
          scheduled_at?: string | null
          source_capture_id?: string | null
          started_at?: string | null
          technician_name?: string | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "visits_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "visits_source_capture_fk"
            columns: ["source_capture_id"]
            isOneToOne: false
            referencedRelation: "raw_captures"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "visits_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      capture_channel:
        | "technician_voice"
        | "technician_photo"
        | "technician_note"
        | "phone_call"
        | "web_form"
        | "sms"
        | "email"
        | "chat"
        | "manager_assistant"
        | "manual_correction"
        | "sales_note"
        | "quote"
        | "crm_import"
        | "accounting_event"
        | "iot"
        | "outbound_email"
      job_status:
        | "open"
        | "in_progress"
        | "completed"
        | "invoiced"
        | "paid"
        | "cancelled"
        | "declined"
      review_status: "open" | "resolved" | "dismissed"
      technician_state:
        | "invited"
        | "pending_verification"
        | "active"
        | "offboarding"
        | "offboarded"
      technician_tier: "manager" | "technician"
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
    Enums: {
      capture_channel: [
        "technician_voice",
        "technician_photo",
        "technician_note",
        "phone_call",
        "web_form",
        "sms",
        "email",
        "chat",
        "manager_assistant",
        "manual_correction",
        "sales_note",
        "quote",
        "crm_import",
        "accounting_event",
        "iot",
        "outbound_email",
      ],
      job_status: [
        "open",
        "in_progress",
        "completed",
        "invoiced",
        "paid",
        "cancelled",
        "declined",
      ],
      review_status: ["open", "resolved", "dismissed"],
      technician_state: [
        "invited",
        "pending_verification",
        "active",
        "offboarding",
        "offboarded",
      ],
      technician_tier: ["manager", "technician"],
    },
  },
} as const
