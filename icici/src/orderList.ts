import configService from './prism/ConfigService';


export function isPriceInRange(price) {
    const minPrice = configService.getConfig().settings.minPrice;
    const maxPrice = configService.getConfig().settings.maxPrice;
    // console.log('Checking price in range', price, minPrice, maxPrice);
    return price >=minPrice && price <=maxPrice
}
