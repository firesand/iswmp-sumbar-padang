package id.iswmp.padang.attendance;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.location.GnssStatus;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;

import androidx.annotation.NonNull;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.google.firebase.appcheck.AppCheckToken;
import com.google.firebase.appcheck.FirebaseAppCheck;

import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

/**
 * OS-level location integrity evidence for the ISWMP attendance flow.
 *
 * The web bundle can measure the *shape* of a GPS signal, but only Android can
 * say whether a fix came from a mock provider. This plugin observes the OS
 * location stream for the same window the web layer records its sample series,
 * then reports what the platform saw.
 *
 * It also bridges Firebase App Check: the WebView's JavaScript SDK would
 * otherwise attest as the *web* application with reCAPTCHA, and the backend
 * would never see the attested Android application id it cross-checks device
 * evidence against.
 *
 * Deliberately reports nothing rather than guessing. If no fix was observed the
 * call is rejected, the web layer sends no device evidence, and the backend
 * records that honestly instead of receiving a fabricated clean result.
 */
@CapacitorPlugin(
    name = "IswmpLocationIntegrity",
    permissions = {
      @Permission(
          alias = "location",
          strings = {Manifest.permission.ACCESS_FINE_LOCATION})
    })
public class IswmpLocationIntegrityPlugin extends Plugin {

  private static final long MIN_UPDATE_INTERVAL_MS = 1000L;
  private static final float MIN_UPDATE_DISTANCE_M = 0f;
  /** An observation older than this is stale and must not be reported. */
  private static final long MAX_OBSERVATION_AGE_MS = 180_000L;
  private static final int MAX_APP_VERSION_LENGTH = 40;

  private final AtomicBoolean mockObserved = new AtomicBoolean(false);
  private final AtomicBoolean fixObserved = new AtomicBoolean(false);
  private final AtomicInteger satellitesUsed = new AtomicInteger(0);
  private final AtomicReference<String> provider =
      new AtomicReference<>("unknown");

  private volatile long observationStartedAt = 0L;
  private LocationListener locationListener;
  private GnssStatus.Callback gnssCallback;

  @PluginMethod
  public void beginObservation(PluginCall call) {
    if (getPermissionState("location") != com.getcapacitor.PermissionState.GRANTED) {
      call.reject("LOCATION_PERMISSION_REQUIRED");
      return;
    }
    final LocationManager locationManager = locationManager();
    if (locationManager == null) {
      call.reject("LOCATION_MANAGER_UNAVAILABLE");
      return;
    }

    mockObserved.set(false);
    fixObserved.set(false);
    satellitesUsed.set(0);
    provider.set("unknown");
    observationStartedAt = System.currentTimeMillis();

    getActivity()
        .runOnUiThread(
            () -> {
              try {
                stopObservation(locationManager);
                locationListener = createLocationListener();
                registerProvider(
                    locationManager, LocationManager.GPS_PROVIDER, locationListener);
                registerProvider(
                    locationManager, LocationManager.NETWORK_PROVIDER, locationListener);
                registerGnssStatus(locationManager);
                call.resolve();
              } catch (SecurityException error) {
                call.reject("LOCATION_PERMISSION_REQUIRED");
              } catch (RuntimeException error) {
                call.reject("OBSERVATION_START_FAILED");
              }
            });
  }

  @PluginMethod
  public void getDeviceIntegrity(PluginCall call) {
    final LocationManager locationManager = locationManager();
    final long startedAt = observationStartedAt;
    if (locationManager != null) {
      getActivity().runOnUiThread(() -> stopObservation(locationManager));
    }
    if (startedAt <= 0L) {
      call.reject("OBSERVATION_NOT_STARTED");
      return;
    }
    if (System.currentTimeMillis() - startedAt > MAX_OBSERVATION_AGE_MS) {
      call.reject("OBSERVATION_STALE");
      return;
    }
    if (!fixObserved.get()) {
      // No platform fix means no platform verdict. Reporting "not mocked" here
      // would invent evidence the OS never gave us.
      call.reject("OBSERVATION_UNAVAILABLE");
      return;
    }

    JSObject result = new JSObject();
    result.put("platform", "android");
    result.put("appVersion", appVersion());
    result.put("mockLocationDetected", mockObserved.get());
    result.put("mockLocationCapableAppsDetected", mockCapableAppsPresent());
    result.put("developerOptionsEnabled", developerOptionsEnabled());
    result.put("locationProvider", provider.get());
    result.put("satellitesUsed", satellitesUsed.get());
    call.resolve(result);
  }

  /**
   * Firebase App Check token from the *native* SDK, which is registered with the
   * Play Integrity provider. The web layer feeds this to a JavaScript
   * CustomProvider so callable requests arrive on the Android application id.
   */
  @PluginMethod
  public void getAppCheckToken(PluginCall call) {
    resolveAppCheckToken(call, false);
  }

  /** Limited-use variant, for callables that enable replay protection. */
  @PluginMethod
  public void getLimitedUseAppCheckToken(PluginCall call) {
    resolveAppCheckToken(call, true);
  }

  private void resolveAppCheckToken(PluginCall call, boolean limitedUse) {
    try {
      FirebaseAppCheck appCheck = FirebaseAppCheck.getInstance();
      (limitedUse
              ? appCheck.getLimitedUseAppCheckToken()
              : appCheck.getAppCheckToken(false))
          .addOnSuccessListener(
              (AppCheckToken token) -> {
                JSObject result = new JSObject();
                result.put("token", token.getToken());
                result.put("expireTimeMillis", token.getExpireTimeMillis());
                call.resolve(result);
              })
          .addOnFailureListener(error -> call.reject("APP_CHECK_TOKEN_FAILED"));
    } catch (RuntimeException error) {
      call.reject("APP_CHECK_UNAVAILABLE");
    }
  }

  @Override
  protected void handleOnDestroy() {
    LocationManager locationManager = locationManager();
    if (locationManager != null) {
      stopObservation(locationManager);
    }
    super.handleOnDestroy();
  }

  private LocationManager locationManager() {
    Context context = getContext();
    if (context == null) {
      return null;
    }
    return (LocationManager) context.getSystemService(Context.LOCATION_SERVICE);
  }

  private LocationListener createLocationListener() {
    return new LocationListener() {
      @Override
      public void onLocationChanged(@NonNull Location location) {
        fixObserved.set(true);
        provider.set(normalizeProvider(location.getProvider()));
        if (isMocked(location)) {
          mockObserved.set(true);
        }
      }

      @Override
      public void onProviderEnabled(@NonNull String enabledProvider) {}

      @Override
      public void onProviderDisabled(@NonNull String disabledProvider) {}

      @Override
      public void onStatusChanged(String changedProvider, int status, Bundle extras) {}
    };
  }

  private void registerProvider(
      LocationManager locationManager, String providerName, LocationListener listener) {
    if (!locationManager.getAllProviders().contains(providerName)) {
      return;
    }
    locationManager.requestLocationUpdates(
        providerName,
        MIN_UPDATE_INTERVAL_MS,
        MIN_UPDATE_DISTANCE_M,
        listener,
        Looper.getMainLooper());
  }

  private void registerGnssStatus(LocationManager locationManager) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) {
      return;
    }
    gnssCallback =
        new GnssStatus.Callback() {
          @Override
          public void onSatelliteStatusChanged(@NonNull GnssStatus status) {
            int used = 0;
            for (int index = 0; index < status.getSatelliteCount(); index += 1) {
              if (status.usedInFix(index)) {
                used += 1;
              }
            }
            satellitesUsed.set(used);
          }
        };
    locationManager.registerGnssStatusCallback(
        gnssCallback, new Handler(Looper.getMainLooper()));
  }

  private void stopObservation(LocationManager locationManager) {
    if (locationListener != null) {
      try {
        locationManager.removeUpdates(locationListener);
      } catch (RuntimeException ignored) {
        // Removing an already-released listener must not crash the WebView.
      }
      locationListener = null;
    }
    if (gnssCallback != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      try {
        locationManager.unregisterGnssStatusCallback(gnssCallback);
      } catch (RuntimeException ignored) {
        // Same reasoning as above.
      }
      gnssCallback = null;
    }
  }

  private boolean isMocked(Location location) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      return location.isMock();
    }
    return location.isFromMockProvider();
  }

  private String normalizeProvider(String providerName) {
    if (providerName == null) {
      return "unknown";
    }
    switch (providerName) {
      case LocationManager.GPS_PROVIDER:
        return "gps";
      case LocationManager.NETWORK_PROVIDER:
        return "network";
      case LocationManager.PASSIVE_PROVIDER:
        return "passive";
      default:
        return "fused".equals(providerName) ? "fused" : "unknown";
    }
  }

  private boolean developerOptionsEnabled() {
    Context context = getContext();
    if (context == null) {
      return false;
    }
    try {
      return Settings.Global.getInt(
              context.getContentResolver(),
              Settings.Global.DEVELOPMENT_SETTINGS_ENABLED,
              0)
          != 0;
    } catch (RuntimeException error) {
      return false;
    }
  }

  /**
   * Best effort only. From Android 11 package visibility hides most installed
   * applications unless the app declares QUERY_ALL_PACKAGES, which this build
   * deliberately does not request. Expect false on modern devices; treat it as
   * a bonus signal, never as proof that no mock application is installed.
   */
  private boolean mockCapableAppsPresent() {
    Context context = getContext();
    if (context == null) {
      return false;
    }
    try {
      PackageManager packageManager = context.getPackageManager();
      List<PackageInfo> packages =
          packageManager.getInstalledPackages(PackageManager.GET_PERMISSIONS);
      String ownPackage = context.getPackageName();
      for (PackageInfo info : packages) {
        if (info.packageName == null
            || info.packageName.equals(ownPackage)
            || info.requestedPermissions == null) {
          continue;
        }
        for (String permission : info.requestedPermissions) {
          if ("android.permission.ACCESS_MOCK_LOCATION".equals(permission)) {
            return true;
          }
        }
      }
    } catch (RuntimeException error) {
      return false;
    }
    return false;
  }

  private String appVersion() {
    Context context = getContext();
    if (context == null) {
      return "unknown";
    }
    try {
      String version =
          context
              .getPackageManager()
              .getPackageInfo(context.getPackageName(), 0)
              .versionName;
      if (version == null) {
        return "unknown";
      }
      String sanitized = version.replaceAll("[^A-Za-z0-9 ._+-]", "");
      if (sanitized.isEmpty()) {
        return "unknown";
      }
      return sanitized.length() > MAX_APP_VERSION_LENGTH
          ? sanitized.substring(0, MAX_APP_VERSION_LENGTH)
          : sanitized;
    } catch (PackageManager.NameNotFoundException | RuntimeException error) {
      return "unknown";
    }
  }
}
