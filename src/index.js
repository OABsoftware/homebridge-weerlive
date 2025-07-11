var request = require('request');


var Accessory, Service, Characteristic, UUIDGen;


module.exports = function(homebridge) 
{
  Accessory = homebridge.platformAccessory;
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  UUIDGen = homebridge.hap.uuid;

  homebridge.registerPlatform("homebridge-weerlive", "WeerLive", WeerLivePlatform);
};


//
// WeerLive Platform
//
function WeerLivePlatform(log, config, api) 
{
  this.log = log;
  this.config = config || {};
  this.api = api;

  var apikey = this.config["apikey"];
  var latitude = this.config["latitude"];
  var longitude = this.config["longitude"];
  var sunshineImages = this.config["sunshineImages"];
  var cloudedImages = this.config["cloudedImages"];
  var sunriseOffset = this.config["sunriseOffset"] | 60;
  var sunsetOffset = this.config["sunsetOffset"] | 60;

  if (!apikey) throw new Error("You must provide a config value for 'apikey'.");
  if (!latitude) throw new Error("You must provide a config value for 'latitude'.");
  if (!longitude) throw new Error("You must provide a config value for 'longitude'.");
  if (!sunshineImages) throw new Error("You must provide a config value for 'sunshineImages'.");
  
  this.url = "https://weerlive.nl/api/weerlive_api_v2.php?key=" + apikey + "&locatie=" + latitude + "," + longitude;
  this.timeout = 10000;

  this.sunshineImages = sunshineImages.split(",");

  if(cloudedImages)
  {
    this.cloudedImages = cloudedImages.split(",");
  }
  else
  {
    this.cloudedImages = [];
  }

  this.sunriseOffset = sunriseOffset;
  this.sunsetOffset = sunsetOffset;

  this.accessories = {};

  if (this.api) 
  {
    this.api.on('didFinishLaunching', this.didFinishLaunching.bind(this));
  }
}


WeerLivePlatform.prototype.didFinishLaunching = function() 
{
  // Read the configuration from config.json
  const configAccessories = this.config.accessories || this.config.Accessories;
  this.configAccessories = Array.isArray(configAccessories) ? configAccessories : [];

  // Walk along each of the accessories specified in the configuration
  this.configAccessories.forEach(configAccessory => 
  {
    this.addAccessory(configAccessory);
  });

  // Update the status of each of the accessories now and then every 10 minutes from now on
  this.checkWeatherAndSetAccessoryContactStates();

  setInterval(() =>
  {
    var nowTime = new Date();
    var minutes = nowTime.getMinutes();
    if((minutes % 10) == 0)
    {
      this.checkWeatherAndSetAccessoryContactStates();
    }
  }, 60 * 1000);
};


WeerLivePlatform.prototype.addAccessory = function(configAccessory)
{
  var uid = UUIDGen.generate("WeerLive_" + configAccessory.name);
  var name = configAccessory.name;

  if (!this.accessories[name])
  {
    var accessory = new Accessory(name, uid, 10);

    this.log("Add accessory " + accessory.displayName);

    accessory.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Name, name)
      .setCharacteristic(Characteristic.Manufacturer, "OABsoftware")
      .setCharacteristic(Characteristic.Model, "KNMI WeerLive");

    accessory.addService(Service.ContactSensor, "status")
      .setCharacteristic(Characteristic.ContactSensorState, Characteristic.ContactSensorState.CONTACT_DETECTED)

    this.api.registerPlatformAccessories("homebridge-weerlive", "WeerLive", [accessory]);

    this.accessories[accessory.displayName] = accessory;
  }

  configAccessory.prevStatus = false;
};


WeerLivePlatform.prototype.configureAccessory = function(accessory) 
{
  if(accessory)
  {
    var name = accessory.displayName;

    var existing = this.accessories[name]
    if (existing)
    {
      this.removeAccessory(existing);
    } 

    this.accessories[name] = accessory;
  }
};


WeerLivePlatform.prototype.removeAccessory = function(accessory) 
{
  if (accessory) 
  {
    var name = accessory.displayName;

    try 
    {
      this.api.unregisterPlatformAccessories("homebridge-weerlive", "WeerLive", [accessory]);
    } 
    catch (error) 
    { }

    delete this.accessories[name];
  }
};


WeerLivePlatform.prototype.checkWeatherAndSetAccessoryContactStates = function()
{
  const that = this;

  this.doRequestGet(this.url, function (error, result) 
  {
    if(error === null && result != null)
    {
      try
      {
        var nowTime = new Date();

        // Calculate the times at which the sun rises and sets, and offset them with 90 minutes
        var sunriseTime = that.timeToDate(result.liveweer[0].sup);
        sunriseTime = new Date(sunriseTime.getTime() + that.sunriseOffset * 60 * 1000); // Offset the sunrise time by +60 minutes

        var sunsetTime = that.timeToDate(result.liveweer[0].sunder);
        sunsetTime = new Date(sunsetTime.getTime() - that.sunsetOffset * 60 * 1000);   // Offset the sunset time by -60 minutes

        // Walk along each of the accessories on this platform and update their state
        that.configAccessories.forEach(configAccessory => 
        {
          var accessory = that.accessories[configAccessory.name];
          var contactsensorService = accessory.getService(Service.ContactSensor);
          var contactsensorstateCharacteristic = contactsensorService.getCharacteristic(Characteristic.ContactSensorState);

          var fromTime = that.timeToDate(configAccessory.fromTime);
          var untilTime = that.timeToDate(configAccessory.untilTime);

          var newStatus = (nowTime >= fromTime && nowTime >= sunriseTime && nowTime < untilTime && nowTime < sunsetTime);
          if(newStatus)
          {
            newStatus = newStatus && that.isSunnyWeather(result.liveweer[0], configAccessory);

            for(let i = 0; i < configAccessory.sameHours; i++)
            {
              newStatus = newStatus && that.isSunnyWeather(result.uur_verw[i], configAccessory);
            }

            if(! newStatus && configAccessory.prevStatus && configAccessory.dontCloseOnWeather)
            {
              newStatus = configAccessory.prevStatus;
            }
          }
          else
          {
            if(configAccessory.prevStatus)
            {
              that.log(configAccessory.name + " closed because of the upcoming sunset");
            }
          }

          if(newStatus)
          {
            contactsensorstateCharacteristic.updateValue(Characteristic.ContactSensorState.CONTACT_NOT_DETECTED);
          }
          else
          {
            contactsensorstateCharacteristic.updateValue(Characteristic.ContactSensorState.CONTACT_DETECTED);
          }

          configAccessory.prevStatus = newStatus;

          // that.log("Status " + configAccessory.name + ": " + newStatus.toString());
        });
      }
      catch(ex)
      {
        that.log("Error: " + ex);
      }
    };
  });
}


WeerLivePlatform.prototype.timeToDate = function(timeString)
{
  var timeParts = timeString.split(':');
  var hours = parseInt(timeParts[0]);
  var minutes = parseInt(timeParts[1]);

  var nowTime = new Date();
  nowTime.setHours(0, 0, 0, 0);

  return new Date(nowTime.getTime() + (60 * hours + minutes) * 60 * 1000);
}


WeerLivePlatform.prototype.isSunnyWeather = function(weatherInfo, configAccessory)
{
  var newStatus = false;

  // Check if the accessory's contact was not opened yet
  if(! configAccessory.prevStatus)
  {
    // Check all parameters: image, sun power, temperature and wind
    newStatus = (this.sunshineImages.includes(weatherInfo.image) && weatherInfo.gr >= configAccessory.minSunPower && weatherInfo.temp >= configAccessory.minTemperature && weatherInfo.windbft <= configAccessory.maxWind);
 }
  else
  {
    // Only check the parameters: image and wind
    newStatus = ((this.sunshineImages.includes(weatherInfo.image) || this.cloudedImages.includes(weatherInfo.image)) && weatherInfo.windbft <= configAccessory.maxWind);

    // If the accessory is going to be closed, but was open until now, then log the reason for closing it
    if(! newStatus && configAccessory.prevStatus)
    {
      var reason = "";

      if(! this.sunshineImages.includes(weatherInfo.image))
        reason += "sunny image: " + weatherInfo.image + ", ";

      if(! this.cloudedImages.includes(weatherInfo.image))
        reason += "cloudy image: " + weatherInfo.image + ", ";

      if(weatherInfo.windbft > configAccessory.maxWind)
        reason = "wind: " + weatherInfo.windbft;

      this.log(configAccessory.name + " closing because of " + reason);
    }
  }

  return newStatus;
}


WeerLivePlatform.prototype.doRequestGet = function(url, callback)
{
  const that = this;
  
  request(
  {
    url: url,
    jar: true,
    followAllRedirects: true,
    rejectUnauthorized: false,
    requestCert: true,
    timeout: this.timeout,
    method: "GET"
  },
  function (error, response, body) 
  {
    if(error) 
    {
      that.log("GET failed: %s", error.message);
      callback(error, null);
    }
    else if(response.statusCode !== 200) 
    {
      that.log("GET failed on http error: %s", response.statusCode);
      callback(error, null);
    }
    else 
    {
      try
      {
        var result = JSON.parse(body);

        // that.log("GET RESPONSE:\n" + JSON.stringify(result));

        callback(null, result);
      }
      catch(ex)
      {
        that.log("Error in received JSON data: " + ex);
        
        callback(ex, null);
      }
    }
  });
}
