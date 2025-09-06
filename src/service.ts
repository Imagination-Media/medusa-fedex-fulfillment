import { AbstractFulfillmentProviderService } from "@medusajs/framework/utils"
import {
  CalculatedShippingOptionPrice,
  CalculateShippingOptionPriceDTO,
  CartLineItemDTO,
  CreateFulfillmentResult,
  FulfillmentDTO,
  FulfillmentItemDTO,
  FulfillmentOption,
  FulfillmentOrderDTO,
  Logger,
  ProductVariantDTO,
  ValidateFulfillmentDataContext,
} from "@medusajs/framework/types"
import {
  FedexAddress,
  fedexMapping,
  FedexRateRequestItem,
  FedexShippingRate,
} from "./fedex-api/types"
import { getAuthToken } from "./fedex-api/auth"
import { getShippingRates } from "./fedex-api/get-shipping-rates"
import createFedexShipmentWorkflow from "./workflows/create-shipment"

type InjectedDependencies = {
  logger: Logger
}

type Options = {
  isEnabled: boolean
  clientId: string
  clientSecret: string
  accountNumber: string
  isSandbox: boolean
  enableLogs: boolean
  weightUnitOfMeasure?: "LB" | "KG"
}

class FedexProviderService extends AbstractFulfillmentProviderService {
  static identifier = "fedex"

  protected logger_: Logger
  protected options_: Options
  protected baseUrl_: string

  /**
   * Create a new FedEx provider service.
   * @param logger - The logger instance.
   * @param options - The FedEx options.
   */
  constructor({ logger }: InjectedDependencies, options: Options) {
    super()
    this.logger_ = logger
    this.options_ = options
    this.baseUrl_ = this.options_.isSandbox
      ? "https://apis-sandbox.fedex.com"
      : "https://apis.fedex.com"
  }

  /**
   * Check if the FedEx provider can calculate shipping rates.
   * @returns {Promise<boolean>}
   */
  async canCalculate(): Promise<boolean> {
    if (
      this.options_.weightUnitOfMeasure &&
      this.options_.weightUnitOfMeasure !== "LB" &&
      this.options_.weightUnitOfMeasure !== "KG"
    ) {
      this.logger_.error(
        `Invalid weight unit of measure: ${this.options_.weightUnitOfMeasure}`
      )
      return false
    } else if (!this.options_.weightUnitOfMeasure) {
      this.options_.weightUnitOfMeasure = "LB" // Default to pounds if not specified
    }

    return this.options_.isEnabled
  }

  /**
   * Get fulfillment options from the FedEx API.
   * @returns {Promise<FulfillmentOption[]>}
   */
  async getFulfillmentOptions(): Promise<FulfillmentOption[]> {
    console.log("Entrou no getFulfillmentOptions");
    try {
      return Object.entries(fedexMapping).map(([key, value]) => ({
        id: value,
        carrier_code: value,
        carrier_name: key,
        service_code: value,
        name: key,
      }))
    } catch (error) {
      this.logger_.error("Error getting FedEx fulfillment options:", error)
      throw new Error("Failed to retrieve FedEx fulfillment options")
    }
  }

  /**
   * Calculate shipping price using FedEx API.
   * @param optionData - The shipping option data.
   * @param data - The shipping data.
   * @param context - The context for the shipping request.
   * @returns The calculated shipping price.
   */
  async calculatePrice(
    optionData: CalculateShippingOptionPriceDTO["optionData"],
    data: CalculateShippingOptionPriceDTO["data"],
    context: CalculateShippingOptionPriceDTO["context"]
  ): Promise<CalculatedShippingOptionPrice> {
    const token = await getAuthToken(
      this.baseUrl_,
      this.options_.clientId,
      this.options_.clientSecret
    )
    const baseUrl = this.baseUrl_
    const accountNumber = this.options_.accountNumber

    if (!context.items || context.items.length === 0) {
      throw new Error("Cart is empty")
    }

    // Validate customer address
    if (!context.shipping_address) {
      throw new Error("Missing shipping address in context")
    }

    if (!context.shipping_address.province) {
      throw new Error("Missing shipping address province in context")
    }

    if (!context.shipping_address.postal_code) {
      throw new Error("Missing shipping address postal code in context")
    }

    if (!context.shipping_address.country_code) {
      throw new Error("Missing shipping address country code in context")
    }

    // Validate store address
    if (!context.from_location) {
      throw new Error("Missing store address in context")
    }

    if (!context.from_location.address) {
      throw new Error("Missing store address in context")
    }

    if (!context.from_location.address.province) {
      throw new Error("Missing store address state in context")
    }

    if (!context.from_location.address.postal_code) {
      throw new Error("Missing store address zip in context")
    }

    if (!context.from_location.address.country_code) {
      throw new Error("Missing store address country in context")
    }

    const originAddress: FedexAddress = {
      stateOrProvinceCode: context.from_location.address.province,
      postalCode: context.from_location.address.postal_code,
      countryCode: context.from_location.address.country_code,
    }

    const destinationAddress: FedexAddress = {
      stateOrProvinceCode: context.shipping_address.province,
      postalCode: context.shipping_address.postal_code,
      countryCode: context.shipping_address.country_code,
    }

    const items: FedexRateRequestItem[] = context.items.map(
      (item: CartLineItemDTO & { variant?: ProductVariantDTO }) => ({
        weight: {
          units: "LB",
          value: item.variant?.weight ? item.variant.weight : 1,
        },
      })
    )

    const rates: FedexShippingRate[] = await getShippingRates(
      baseUrl,
      token,
      accountNumber,
      originAddress,
      destinationAddress,
      items,
      this.options_.enableLogs ? this.logger_ : undefined
    )

    // Find matching rate
    const rate = rates.find((r) => r.code === optionData.service_code)

    if (!rate) {
      this.logger_.error(
        "FedEx rate quote response missing expected rate data"
      )
      throw new Error("FedEx rate quote response missing expected rate data")
    }

    return {
      calculated_amount: rate.price!,
      is_calculated_price_tax_inclusive: true,
    }
  }

  /**
   * Validate the fulfillment data for a given shipping option.
   * @param optionData - The shipping option data.
   * @param data - The fulfillment data.
   * @param context - The validation context.
   * @returns A promise that resolves to a boolean indicating whether the fulfillment data is valid.
   */
  async validateFulfillmentData(
    optionData: Record<string, unknown>,
    data: Record<string, unknown>,
    context: ValidateFulfillmentDataContext
  ): Promise<boolean> {
    if (this.options_.enableLogs) {
      this.logger_.info(
        `Validating fulfillment data for option: ${JSON.stringify(
          optionData,
          null,
          2
        )}`
      )
      this.logger_.info(`With data: ${JSON.stringify(data, null, 2)}`)
      this.logger_.info(`With context: ${JSON.stringify(context, null, 2)}`)
    }

    // Nothing to review and approve for now
    return Promise.resolve(true)
  }

  /**
   * Create a fulfillment for a given order.
   * @param data - The fulfillment data.
   * @param items - The line items to fulfill.
   * @param order - The order to fulfill.
   * @param fulfillment - The fulfillment information.
   * @returns A promise that resolves to the fulfillment result.
   */
  async createFulfillment(
    data: Record<string, unknown>,
    items: Partial<Omit<FulfillmentItemDTO, "fulfillment">>[],
    order: Partial<FulfillmentOrderDTO> | undefined,
    fulfillment: Partial<
      Omit<FulfillmentDTO, "provider_id" | "data" | "items">
    >
  ): Promise<CreateFulfillmentResult> {
    const token = await getAuthToken(
      this.baseUrl_,
      this.options_.clientId,
      this.options_.clientSecret
    )
    const baseUrl = this.baseUrl_
    const accountNumber = this.options_.accountNumber

    try {
      const locationId = fulfillment.location_id

      if (!locationId) {
        this.logger_.error("FedEx create fulfillment failed: Missing location ID")
        throw new Error("FedEx create fulfillment failed: Missing location ID")
      }

      const { result } = await createFedexShipmentWorkflow().run({
        input: {
          token,
          baseUrl,
          accountNumber,
          locationId,
          data,
          items,
          order,
          fulfillment,
          debug: this.options_.enableLogs
        }
      });

      console.log(result);

      return result.shipment;
    } catch (error: any) {
      this.logger_.error(`FedEx create fulfillment failed: ${error.message}`)
      throw new Error(`FedEx create fulfillment failed: ${error.message}`)
    }
  }
}

export default FedexProviderService
