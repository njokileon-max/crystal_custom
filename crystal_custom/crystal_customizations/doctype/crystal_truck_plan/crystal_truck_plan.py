import frappe
from frappe.model.document import Document


class CrystalTruckPlan(Document):
    def before_save(self):
        self.order_count = len(self.orders)
        self.total_weight = sum(row.total_net_weight or 0 for row in self.orders)
        self.total_value = sum(row.grand_total or 0 for row in self.orders)
        regions = sorted({row.delivery_region for row in self.orders if row.delivery_region})
        self.delivery_regions = ', '.join(regions)


def _match_vehicle(truck_number):
    """Vehicle In Transit whose plate matches the plan's truck number
    (spaces and case ignored). None when there's no single clear match,
    so the dispatcher picks the vehicle instead of the wrong one being set."""
    plate = (truck_number or "").replace(" ", "").upper()
    if not plate:
        return None
    if frappe.db.exists("Vehicle In Transit", truck_number):
        return truck_number
    if not frappe.db.has_column("Vehicle In Transit", "vehicle_plate"):
        return None
    matches = frappe.db.sql("""
        SELECT name FROM `tabVehicle In Transit`
        WHERE UPPER(REPLACE(IFNULL(vehicle_plate, ''), ' ', '')) = %s
        LIMIT 2
    """, (plate,))
    return matches[0][0] if len(matches) == 1 else None


@frappe.whitelist()
def make_delivery_manifest(source_name):
    """
    Create a Vehicle Delivery Manifest (draft) from a submitted Crystal Truck
    Plan. Stops keep the plan's order (already road-optimised by Dispatch).

    Each stop is filled by nexus_supply_chain.driver_api.build_stop_fields,
    the same builder the manifest controller uses:
      * customer_id (the Customer record) and customer (its name),
      * customer phone,
      * the customer's pin as exact "lat,lng" text via the shared
        coordinate builder (no float rounding, no 0,0 placeholders).
    The vehicle is matched from the plan's truck number; the driver then
    comes from that vehicle's current driver.
    """
    from nexus_supply_chain.driver_api import build_stop_fields

    if not frappe.has_permission("Crystal Truck Plan", "read", source_name):
        frappe.throw("You don't have permission to use this Truck Plan.", frappe.PermissionError)

    existing_manifest = frappe.db.get_value(
        "Vehicle Delivery Manifest",
        {"truck_plan": source_name, "docstatus": ["<", 2]},
        "name",
    )
    if existing_manifest:
        return {
            "status": "exists",
            "manifest_id": existing_manifest,
            "message": "A Delivery Manifest already exists for this Truck Plan.",
        }

    source = frappe.get_doc("Crystal Truck Plan", source_name)
    if source.docstatus != 1:
        frappe.throw("Submit the Truck Plan before creating its Delivery Manifest.")

    target = frappe.new_doc("Vehicle Delivery Manifest")
    target.truck_plan = source.name
    target.trip_status = "Manifested"

    vehicle = _match_vehicle(source.get("truck_number"))
    if vehicle and frappe.db.get_value("Vehicle In Transit", vehicle, "current_status") not in ("Idle", "Loading", None, ""):
        vehicle = None  # busy on another trip: leave it for the dispatcher to choose
    if vehicle:
        target.vehicle = vehicle
        target.driver = frappe.db.get_value("Vehicle In Transit", vehicle, "current_driver")

    target.profit_loss = source.narrowed_gross_profit
    target.gross_margin = source.narrowed_gross_margin_percentage
    target.approximate_total_distance_km = source.approximate_total_distance_km
    target.approximate_fuel_consumption_ltrs = source.approximate_fuel_consumption_ltrs
    target.approximate_fuel_cost = source.approximate_fuel_cost
    target.actual_fuel_fuelled = source.actual_fuel_fuelled
    target.profitability_status = source.profitability_status
    target.route_geojson = source.route_geojson

    missing_pins = []
    for order_row in source.orders:
        if not order_row.sales_order:
            continue
        stop = build_stop_fields(order_row.sales_order)
        if not stop:
            continue
        if order_row.get("customer_name"):
            stop["customer"] = order_row.customer_name
        stop["weight_kg"] = order_row.total_net_weight
        stop["delivery_status"] = "Pending"
        if not stop.get("combined_coordinates"):
            missing_pins.append(stop.get("customer") or order_row.sales_order)
        target.append("stops", stop)

    target.insert(ignore_permissions=True)

    message = "Vehicle Delivery Manifest drafted successfully."
    if not vehicle:
        message += " Select the vehicle before submitting (no free vehicle matched the truck number)."
    if missing_pins:
        message += f" {len(missing_pins)} stop(s) have no customer location yet."

    return {
        "status": "success",
        "manifest_id": target.name,
        "message": message,
        "vehicle_matched": bool(vehicle),
        "stops_without_location": missing_pins,
    }
