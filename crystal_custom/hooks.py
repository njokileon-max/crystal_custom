app_name = "crystal_custom"
app_title = "Crystal Customizations"
app_publisher = "wangui"
app_description = "crystal customizations"
app_email = "wangui.work@gmail.com"
app_license = "mit"

# Fixtures – installed automatically on `bench migrate` / `bench install-app`
fixtures = [
    # Custom fields on Sales Order and Delivery Note
    {
        "dt": "Custom Field",
        "filters": [
            ["dt", "in", ["Sales Order", "Delivery Note"]],
            ["fieldname", "in", [
                "custom_logistics_section",
                "custom_delivery_region",
                "custom_phone_number",
                "custom_col_break_logistics",
                "custom_on_hold",
                "custom_call_not_picked",
                "custom_call_notes",
                "custom_finance_rejection_note",
                "custom_truck_section",
                "custom_truck_number",
                "custom_truck_closed",
                "custom_truck_dismantled",
                "custom_truck_dispatched",
                "custom_is_pre_fulfillment",
            ]],
        ],
    },
    # Sales Order approval workflow
    {
        "dt": "Workflow",
        "filters": [["document_type", "=", "Sales Order"]],
    },
    # Workflow states referenced by the workflow above
    {
        "dt": "Workflow State",
        "filters": [["workflow_state_name", "in", [
            "Proceed To Order",
            "Pending Finance Approval",
            "Pending Customer Order Reconfirmation",
            "Order Confirmed",
        ]]],
    },
    # Workflow actions referenced by the workflow above
    {
        "dt": "Workflow Action Master",
        "filters": [["workflow_action_name", "in", [
            "Submit to Finance",
            "Approve",
            "Reject",
            "Confirm Order",
            "Return to Order Manager",
        ]]],
    },
]

# ─── DOCUMENT EVENTS (HOOKS) ──────────────────────────────────────────────────
# Listens natively to standard ERPNext documents to trigger background syncs

doc_events = {
    "Delivery Note": {
        "on_submit": "crystal_custom.crystal_customizations.events.delivery_note.on_submit",
        "on_cancel": "crystal_custom.crystal_customizations.events.delivery_note.on_cancel"
    },
    "Payment Entry": {
        "on_submit": "crystal_custom.crystal_customizations.events.payment_entry.on_submit",
        "on_cancel": "crystal_custom.crystal_customizations.events.payment_entry.on_cancel",
        "on_trash": "crystal_custom.crystal_customizations.events.payment_entry.on_trash"
    }
}

# Apps
# ------------------

# required_apps = []

# Each item in the list will be shown as an app in the apps page
# add_to_apps_screen = [
# 	{
# 		"name": "crystal_custom",
# 		"logo": "/assets/crystal_custom/logo.png",
# 		"title": "Crystal Customizations",
# 		"route": "/crystal_custom",
# 		"has_permission": "crystal_custom.api.permission.has_app_permission"
# 	}
# ]

# Includes in <head>
# ------------------

# include js, css files in header of desk.html
# app_include_css = "/assets/crystal_custom/css/crystal_custom.css"
# app_include_js = "/assets/crystal_custom/js/crystal_custom.js"

# include js, css files in header of web template
# web_include_css = "/assets/crystal_custom/css/crystal_custom.css"
# web_include_js = "/assets/crystal_custom/js/crystal_custom.js"

# include custom scss in every website theme (without file extension ".scss")
# website_theme_scss = "crystal_custom/public/scss/website"

# include js, css files in header of web form
# webform_include_js = {"doctype": "public/js/doctype.js"}
# webform_include_css = {"doctype": "public/css/doctype.css"}

# include js in page
# page_js = {"page" : "public/js/file.js"}

# include js in doctype views
# doctype_js = {"doctype" : "public/js/doctype.js"}
# doctype_list_js = {"doctype" : "public/js/doctype_list.js"}
doctype_list_js = {"Purchase Invoice": "public/js/purchase_invoice_list.js"}
# doctype_tree_js = {"doctype" : "public/js/doctype_tree.js"}
# doctype_calendar_js = {"doctype" : "public/js/doctype_calendar.js"}

# Svg Icons
# ------------------
# include app icons in desk
# app_include_icons = "crystal_custom/public/icons.svg"

# Home Pages
# ----------

# application home page (will override Website Settings)
# home_page = "login"

# website user home page (by Role)
# role_home_page = {
# 	"Role": "home_page"
# }

# Generators
# ----------

# automatically create page for each record of this doctype
# website_generators = ["Web Page"]

# Jinja
# ----------

# add methods and filters to jinja environment
# jinja = {
# 	"methods": "crystal_custom.utils.jinja_methods",
# 	"filters": "crystal_custom.utils.jinja_filters"
# }

# Installation
# ------------

# before_install = "crystal_custom.install.before_install"
# after_install = "crystal_custom.install.after_install"
after_install = "crystal_custom.setup.after_install"

# Uninstallation
# ------------

# before_uninstall = "crystal_custom.uninstall.before_uninstall"
# after_uninstall = "crystal_custom.uninstall.after_uninstall"

# Integration Setup
# ------------------
# To set up dependencies/integrations with other apps
# Name of the app being installed is passed as an argument

# before_app_install = "crystal_custom.utils.before_app_install"
# after_app_install = "crystal_custom.utils.after_app_install"

# Integration Cleanup
# -------------------
# To clean up dependencies/integrations with other apps
# Name of the app being uninstalled is passed as an argument

# before_app_uninstall = "crystal_custom.utils.before_app_uninstall"
# after_app_uninstall = "crystal_custom.utils.after_app_uninstall"

# Desk Notifications
# ------------------
# See frappe.core.notifications.get_notification_config

# notification_config = "crystal_custom.notifications.get_notification_config"

# Permissions
# -----------
# Permissions evaluated in scripted ways

# permission_query_conditions = {
# 	"Event": "frappe.desk.doctype.event.event.get_permission_query_conditions",
# }
#
# has_permission = {
# 	"Event": "frappe.desk.doctype.event.event.has_permission",
# }

# DocType Class
# ---------------
# Override standard doctype classes

# override_doctype_class = {
# 	"ToDo": "custom_app.overrides.CustomToDo"
# }

# Document Events
# ---------------
# Hook on document methods and events

# doc_events = {
# 	"*": {
# 		"on_update": "method",
# 		"on_cancel": "method",
# 		"on_trash": "method"
# 	}
# }

# Scheduled Tasks
# ---------------

# scheduler_events = {
# 	"all": [
# 		"crystal_custom.tasks.all"
# 	],
# 	"daily": [
# 		"crystal_custom.tasks.daily"
# 	],
# 	"hourly": [
# 		"crystal_custom.tasks.hourly"
# 	],
# 	"weekly": [
# 		"crystal_custom.tasks.weekly"
# 	],
# 	"monthly": [
# 		"crystal_custom.tasks.monthly"
# 	],
# }

# Testing
# -------

# before_tests = "crystal_custom.install.before_tests"

# Overriding Methods
# ------------------------------
#
# override_whitelisted_methods = {
# 	"frappe.desk.doctype.event.event.get_events": "crystal_custom.event.get_events"
# }
#
# each overriding function accepts a `data` argument;
# generated from the base implementation of the doctype dashboard,
# along with any modifications made in other Frappe apps
# override_doctype_dashboards = {
# 	"Task": "crystal_custom.task.get_dashboard_data"
# }

# exempt linked doctypes from being automatically cancelled
#
# auto_cancel_exempted_doctypes = ["Auto Repeat"]

# Ignore links to specified DocTypes when deleting documents
# -----------------------------------------------------------

# ignore_links_on_delete = ["Communication", "ToDo"]

# Request Events
# ----------------
# before_request = ["crystal_custom.utils.before_request"]
# after_request = ["crystal_custom.utils.after_request"]

# Job Events
# ----------
# before_job = ["crystal_custom.utils.before_job"]
# after_job = ["crystal_custom.utils.after_job"]

# User Data Protection
# --------------------

# user_data_fields = [
# 	{
# 		"doctype": "{doctype_1}",
# 		"filter_by": "{filter_by}",
# 		"redact_fields": ["{field_1}", "{field_2}"],
# 		"partial": 1,
# 	},
# 	{
# 		"doctype": "{doctype_2}",
# 		"filter_by": "{filter_by}",
# 		"partial": 1,
# 	},
# 	{
# 		"doctype": "{doctype_3}",
# 		"strict": False,
# 	},
# 	{
# 		"doctype": "{doctype_4}"
# 	}
# ]

# Authentication and authorization
# --------------------------------

# auth_hooks = [
# 	"crystal_custom.auth.validate"
# ]

# Automatically update python controller files with type annotations for this app.
# export_python_type_annotations = True

# default_log_clearing_doctypes = {
# 	"Logging DocType Name": 30  # days to retain logs
# }

